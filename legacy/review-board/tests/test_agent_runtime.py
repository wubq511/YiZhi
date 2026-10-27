"""C4/C7 integration regressions through a controlled executor port.

Run from legacy/review-board: python3 -B -m unittest discover -s tests -p test_agent_runtime.py -v
Every course is a disposable copy of actual knowledge, tools and source assets.
No subprocess/CLI is launched. Queue replies and Events establish race ordering;
the fake deliberately permits events after interrupt, just like an RPC peer can.
"""
from contextlib import closing
from copy import deepcopy
import json
from pathlib import Path
import queue
import shutil
import sqlite3
import sys
import tempfile
import threading
import time
import unittest

from reviewboard.agent_runtime import AgentRuntime, digest
from reviewboard.service import CourseService
from reviewboard.storage import StoreError

from reviewboard.paths import DEFAULT_COURSE_ROOT

PROJECT = DEFAULT_COURSE_ROOT
UNIT = "KU-035"
CORE = "RB-KU-035-core"
WARNING = "RB-KU-035-warning"
TIMEOUT = 5
QUESTION = "继续时应依据哪一版材料？"


class FakeExecutor:
    """Only the executor is replaced; all commands and persistence stay real."""

    def __init__(self, serial, *, connect_error=None, actual=None, steer_error=None):
        self.serial = serial
        self.connect_error, self.steer_error = connect_error, steer_error
        self.actual = deepcopy(actual or {"thread": {"turns": []}})
        self.thread_id = self.turn_id = None
        self.context = None
        self.started = threading.Event()
        self.interrupted = threading.Event()
        self.closed = threading.Event()
        self.reconciled = threading.Event()
        self.events = queue.Queue()
        self.steers = queue.Queue()
        self.replies = queue.Queue()
        self.request_replies = queue.Queue()
        self._serial = 0

    def connect(self):
        if self.connect_error:
            raise self.connect_error
        return self

    def start(self, prompt, on_mapping):
        self.context = json.loads(prompt)
        self.thread_id = f"THREAD-FAKE-{self.serial}"
        self.turn_id = f"TURN-FAKE-{self.serial}"
        on_mapping({"threadId": self.thread_id, "turnId": self.turn_id})
        self.started.set()

    def next_event(self):
        try:
            return self.events.get(timeout=.1)
        except queue.Empty:
            return None

    def reply_tool(self, identifier, value, success=True):
        self.replies.put((identifier, deepcopy(value), success))

    def reply_request(self, identifier, result):
        self.request_replies.put((identifier, deepcopy(result)))

    def interrupt(self):
        self.interrupted.set()

    def steer(self, text):
        self.steers.put(text)
        if self.steer_error:
            raise self.steer_error
        return {"turnId": self.turn_id}

    def reconcile(self, mapping):
        self.mapping = deepcopy(mapping)
        self.reconciled.set()
        return deepcopy(self.actual)

    def close(self):
        self.closed.set()
        self.events.put(None)  # Wake a worker blocked in next_event, including cleanup.

    def emit(self, method, **params):
        self.events.put({"method": method, "params": params})

    def input_request(self, identifier="INPUT-1"):
        event = {"id": identifier, "method": "item/tool/requestUserInput", "params": {
            "threadId": self.thread_id, "turnId": self.turn_id, "itemId": "input-item",
            "questions": [{"id": "basis", "header": "核对依据", "question": QUESTION}]}}
        self.events.put(deepcopy(event))
        return event

    def tool(self, name, arguments, *, identifier=None):
        self._serial += 1
        identifier = identifier or f"CALL-{self.serial}-{self._serial}"
        self.events.put({"id": identifier, "method": "item/tool/call",
                         "params": {"tool": name, "arguments": deepcopy(arguments)}})
        try:
            received, value, success = self.replies.get(timeout=TIMEOUT)
        except queue.Empty as exc:
            raise AssertionError(f"No reply for {name}; executor closed={self.closed.is_set()}") from exc
        if received != identifier:
            raise AssertionError(f"Unexpected tool reply {received}, expected {identifier}")
        return value, success

    def complete(self, text=None, *, item="answer", status="completed"):
        if text is not None:
            self.emit("item/completed", item={"id": item, "type": "agentMessage",
                                            "phase": "final_answer", "text": text})
        self.emit("turn/completed", turn={"id": self.turn_id, "status": status})


class ExecutorFactory:
    def __init__(self, **options):
        self.options = options
        self.instances = []
        self.condition = threading.Condition()

    def __call__(self, root, model=None):
        with self.condition:
            executor = FakeExecutor(len(self.instances) + 1, **self.options)
            self.instances.append(executor)
            self.condition.notify_all()
            return executor

    def get(self, index=0, *, started=True):
        with self.condition:
            if not self.condition.wait_for(lambda: len(self.instances) > index, timeout=TIMEOUT):
                raise AssertionError(f"Executor {index} was never created")
            executor = self.instances[index]
        if started and not executor.started.wait(TIMEOUT):
            raise AssertionError(f"Executor {index} never started")
        return executor


class AgentRuntimeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Freeze one coherent input for this suite while the content line works.
        cls.template_dir = tempfile.TemporaryDirectory(prefix="agent-course-template-")
        cls.addClassCleanup(cls.template_dir.cleanup)
        cls.template = Path(cls.template_dir.name)
        knowledge = PROJECT / "期中/数据/知识地图.json"
        data = json.loads(knowledge.read_text(encoding="utf-8"))
        paths = {"期中/数据/视图布局.json"}
        paths.update(s["path"] for s in data["sources"])
        paths.update(v["path"] for s in data["sources"] for v in s.get("versions", []))
        paths.update(f"期中/工具/{name}" for name in ("知识地图.py", "地图生成.py", "复习内容.py"))
        for relative in paths:
            destination = cls.template / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(PROJECT / relative, destination)
        (cls.template / "期中/数据/知识地图.json").write_text(
            json.dumps(data, ensure_ascii=False), encoding="utf-8")

    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="agent-runtime-test-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name) / "course"
        shutil.copytree(self.template, self.root)
        # KnowledgeCatalog inserts copied tool directories in sys.path.
        original_path = sys.path[:]
        self.addCleanup(lambda: sys.path.__setitem__(slice(None), original_path))
        self.service = CourseService(self.root)
        self.service.content.get(UNIT)  # Establish actual knowledge baseline before requests.
        self.factory = ExecutorFactory()
        self.runtime = AgentRuntime(self.service, executor_factory=self.factory)
        # CourseService owns notification/lifecycle wiring; do not invoke its default CLI factory.
        self.service._agent = self.runtime
        self.runtimes = [self.runtime]
        self.addCleanup(self.stop)

    def stop(self):
        try:
            if self.service:
                self.service.close()
        finally:
            # This is a lifecycle check only, never a behavioral test seam.
            alive = [w for runtime in self.runtimes for w in runtime._workers if w.is_alive()]
            self.assertEqual(alive, [], "AgentRuntime leaked workers into the next test")

    def request(self, kind="edit", **overrides):
        value = {"requestId": "REQ-" + str(time.monotonic_ns()), "requestKind": kind,
                 "target": {"objectId": UNIT, "blockId": CORE, "text": "提交时固定选段"},
                 "instruction": "解释此段" if kind == "ask" else "在目标段补充一句说明"}
        value.update(overrides)
        return value

    def start(self, kind="edit", **overrides):
        index = len(self.factory.instances)
        task = self.runtime.submit(self.request(kind, **overrides))
        return task, self.factory.get(index)

    def task(self, identifier):
        return self.service.store.read("tasks", identifier)["value"]

    def wait_task(self, identifier, predicate, message="task state did not settle"):
        deadline = time.monotonic() + TIMEOUT
        wake = threading.Event()
        while time.monotonic() < deadline:
            value = self.task(identifier)
            if predicate(value):
                return value
            wake.wait(.01)
        self.fail(f"{message}: {self.task(identifier)!r}")

    def finish(self, task, executor, text="已处理"):
        executor.complete(text)
        self.assertTrue(executor.closed.wait(TIMEOUT), "Completed executor was not closed")
        return self.task(task["taskId"])

    def read(self, executor, unit=UNIT):
        value, success = executor.tool("review_get", {"unitId": unit})
        self.assertTrue(success, value)
        return value

    def edit_args(self, base, block=CORE, text="Agent 补充说明"):
        old = next(b for b in base["entity"]["reading"]["blocks"] if b["id"] == block)
        return {"unitId": base["id"], "baseHash": base["hash"],
                "edits": [{"blockId": block, "payload": {**old["payload"], "text": text}}],
                "summary": "补充段落", "materialChange": False, "materialReason": ""}

    def edit(self, executor, args, *, identifier=None):
        result, success = executor.tool("review_edit", args, identifier=identifier)
        self.assertTrue(success, result)
        self.assertTrue(result["saved"], result)
        return result

    def block_text(self, block=CORE):
        entity = self.service.content.get(UNIT)["entity"]
        return next(b["payload"]["text"] for b in entity["reading"]["blocks"] if b["id"] == block)

    def student_edit(self, block=WARNING, text="学生最新说明"):
        base = self.service.content.get(UNIT)
        entity = deepcopy(base["entity"])
        next(b for b in entity["reading"]["blocks"] if b["id"] == block)["payload"]["text"] = text
        return self.service.apply_command({"operationId": "OP-STUDENT-" + str(time.monotonic_ns()),
            "actor": "student", "kind": "knowledge.edit", "generation": base["generation"],
            "expectedRevisions": {f"knowledge:{UNIT}": base["revision"]},
            "changes": [{"namespace": "knowledge", "key": UNIT, "value": entity}]})

    def messages(self, task):
        return [m for m in self.runtime.conversation(task["conversationId"])["messages"]
                if m.get("taskId") == task["taskId"] and m["role"] == "assistant"]

    def sql(self, statement):
        # Real SQLite failure injection; neither service nor store methods are mocked.
        with closing(sqlite3.connect(self.root / self.service.manifest["state"])) as db, db:
            db.execute(statement)

    def reopen(self, **executor_options):
        self.service.close()
        self.service = CourseService(self.root)
        self.service.content.get(UNIT)
        self.factory = ExecutorFactory(**executor_options)
        self.runtime = AgentRuntime(self.service, executor_factory=self.factory)
        self.service._agent = self.runtime
        self.runtimes.append(self.runtime)

    def knowledge_events(self):
        return [e for e in self.service.store.events_since(0, limit=10000)["events"]
                if e["actor"] == "agent" and any(c["namespace"] == "knowledge" for c in e["changes"])]

    def pending_input(self, task, executor):
        event = executor.input_request()
        self.read(executor)  # Event-order barrier: the input request has been persisted.
        current = self.task(task["taskId"])
        self.assertEqual(current["status"], "needs_input")
        self.assertEqual(current["pendingRequest"]["id"], event["id"])
        return event

    def assert_resolve_rejected(self, task):
        with self.assertRaises(StoreError) as caught:
            self.runtime.control(task["taskId"], "resolve", {"response": {"answers": {"basis": "旧答复"}}})
        self.assertEqual(caught.exception.code, "invalid_parameter")

    def test_ask_cannot_write_even_when_executor_attempts_edit(self):
        original = (self.root / "期中/数据/知识地图.json").read_bytes()
        task, executor = self.start("ask")
        result, success = executor.tool("review_edit", self.edit_args(self.read(executor)))
        self.assertFalse(success, result)
        self.assertEqual(result["error"]["code"], "invalid_parameter")
        final = self.finish(task, executor, "只解释，不修改")
        self.assertEqual(final["status"], "completed")
        self.assertEqual(final["operationIds"], [])
        self.assertEqual((self.root / "期中/数据/知识地图.json").read_bytes(), original)

    def test_request_retry_is_one_task_and_different_payload_is_rejected(self):
        request = self.request()
        task = self.runtime.submit(request)
        executor = self.factory.get()
        retry = self.runtime.submit(deepcopy(request))
        self.assertEqual(retry["taskId"], task["taskId"])
        with self.assertRaises(StoreError) as caught:
            self.runtime.submit({**request, "instruction": "这是另一项修改"})
        self.assertEqual(caught.exception.code, "invalid_parameter")
        self.finish(task, executor)
        self.assertEqual(self.runtime.submit(request)["taskId"], task["taskId"])
        self.assertEqual(len(self.factory.instances), 1)
        users = [m for m in self.runtime.conversation(task["conversationId"])["messages"] if m["role"] == "user"]
        self.assertEqual(len(users), 1)

    def test_duplicate_tool_events_return_original_commit_after_later_student_edit(self):
        task, executor = self.start()
        args = self.edit_args(self.read(executor))
        saved = self.edit(executor, args, identifier="CALL-REPLAYED")
        self.student_edit(CORE, "学生在已提交结果上继续修改")
        repeated = self.edit(executor, args, identifier="CALL-REPLAYED")
        final = self.finish(task, executor)
        self.assertEqual(final["operationIds"], [saved["operationId"]])
        self.assertEqual(len(self.knowledge_events()), 1)
        self.assertEqual(self.block_text(), "学生在已提交结果上继续修改")
        self.assertEqual(set(repeated), set(saved), "A retry must preserve the original tool result fields")
        self.assertEqual(repeated, saved)

    def test_stop_rejects_new_late_write_and_keeps_committed_operation(self):
        task, executor = self.start()
        saved = self.edit(executor, self.edit_args(self.read(executor)))
        late = self.edit_args(self.read(executor), text="停止后的迟到覆盖")
        self.runtime.control(task["taskId"], "stop")
        self.assertTrue(executor.interrupted.wait(TIMEOUT))
        result, success = executor.tool("review_edit", late)
        self.assertFalse(success, result)
        self.assertEqual(result["error"]["code"], "revision_conflict")
        final = self.finish(task, executor)
        self.assertEqual(final["status"], "interrupted")
        self.assertEqual(final["operationIds"], [saved["operationId"]])
        self.assertEqual(self.block_text(), "Agent 补充说明")

    def test_stop_then_late_permission_cannot_revive_task_or_accept_a_late_write(self):
        task, executor = self.start()
        saved = self.edit(executor, self.edit_args(self.read(executor)))
        late_write = self.edit_args(self.read(executor), text="停止后不得复活写入")
        self.runtime.control(task["taskId"], "stop")
        self.assertTrue(executor.interrupted.wait(TIMEOUT))
        executor.input_request("INPUT-AFTER-STOP")
        self.read(executor)
        current = self.task(task["taskId"])
        self.assertEqual(current["status"], "interrupted")
        self.assertIsNone(current.get("pendingRequest"))
        self.assert_resolve_rejected(task)
        self.assertTrue(executor.request_replies.empty())
        result, success = executor.tool("review_edit", late_write)
        self.assertFalse(success, result)
        self.assertEqual(result["error"]["code"], "revision_conflict")
        final = self.finish(task, executor)
        self.assertEqual(final["status"], "interrupted")
        self.assertEqual(final["operationIds"], [saved["operationId"]])
        self.assertEqual(self.block_text(), "Agent 补充说明")

    def test_permission_for_old_thread_or_turn_is_rejected_after_continue(self):
        task, old = self.start("ask")
        self.runtime.control(task["taskId"], "stop")
        self.finish(task, old)
        self.runtime.control(task["taskId"], "continue")
        current = self.factory.get(1)
        for thread_id, turn_id in ((old.thread_id, current.turn_id), (current.thread_id, old.turn_id)):
            with self.subTest(thread=thread_id, turn=turn_id):
                current.events.put({"id": "INPUT-OLD", "method": "item/tool/requestUserInput", "params": {
                    "threadId": thread_id, "turnId": turn_id,
                    "questions": [{"id": "basis", "question": QUESTION}]}})
                self.read(current)
                self.assertEqual(self.task(task["taskId"])["status"], "running")
                self.assertIsNone(self.task(task["taskId"]).get("pendingRequest"))
                self.assert_resolve_rejected(task)
                self.assertTrue(current.request_replies.empty())
        self.pending_input(task, current)
        response = {"answers": {"basis": "当前轮次的答复"}}
        self.runtime.control(task["taskId"], "resolve", {"response": response})
        self.assertEqual(current.request_replies.get(timeout=TIMEOUT), ("INPUT-1", response))
        self.assertTrue(old.request_replies.empty())
        self.assertEqual(self.task(task["taskId"])["status"], "running")
        self.finish(task, current)

    def test_restart_retires_pending_input_preserves_question_and_continues_with_new_executor(self):
        task, old = self.start("ask")
        self.pending_input(task, old)
        self.reopen(actual={"thread": {"turns": [{"id": old.turn_id, "status": "inProgress"}]}})
        probe = self.factory.get(started=False)
        self.assertTrue(probe.closed.wait(TIMEOUT))
        recovered = self.wait_task(task["taskId"], lambda t: t["status"] == "needs_input")
        self.assertIsNone(recovered.get("pendingRequest"))
        self.assertIn(QUESTION, recovered["recoveryNote"])
        self.assert_resolve_rejected(task)
        self.assertTrue(old.request_replies.empty())
        self.assertTrue(probe.request_replies.empty())
        self.runtime.control(task["taskId"], "continue")
        resumed = self.factory.get(1)
        self.assert_resolve_rejected(task)  # An old UI answer cannot target the fresh executor.
        self.assertTrue(resumed.request_replies.empty())
        self.pending_input(task, resumed)
        response = {"answers": {"basis": "重开后的新答复"}}
        self.runtime.control(task["taskId"], "resolve", {"response": response})
        self.assertEqual(resumed.request_replies.get(timeout=TIMEOUT), ("INPUT-1", response))
        self.finish(task, resumed)

    def test_disconnect_and_failed_reconcile_retire_pending_input_and_keep_question(self):
        task, old = self.start("ask")
        self.pending_input(task, old)
        self.factory.options["connect_error"] = StoreError("executor_unavailable", "核对连接不可用")
        old.emit("connection/closed")
        probe = self.factory.get(1, started=False)
        self.assertTrue(probe.closed.wait(TIMEOUT))
        recovered = self.wait_task(task["taskId"], lambda t: t["status"] == "needs_input")
        self.assertIsNone(recovered.get("pendingRequest"))
        self.assertIn(QUESTION, recovered["recoveryNote"])
        self.assertIn("核对连接不可用", recovered["reconcileError"])
        self.assert_resolve_rejected(task)
        self.assertTrue(old.request_replies.empty())
        self.factory.options.pop("connect_error")
        self.runtime.control(task["taskId"], "continue")
        resumed = self.factory.get(2)
        self.assert_resolve_rejected(task)
        self.assertTrue(resumed.request_replies.empty())
        self.finish(task, resumed)

    def test_completed_turn_recovery_clears_old_pending_input_and_keeps_question_note(self):
        task, old = self.start("ask")
        self.pending_input(task, old)
        actual = {"thread": {"turns": [{"id": old.turn_id, "status": "completed", "items": [
            {"id": "answer", "type": "agentMessage", "phase": "final_answer", "text": "已核对并完成"}]}]}}
        self.reopen(actual=actual)
        probe = self.factory.get(started=False)
        self.assertTrue(probe.closed.wait(TIMEOUT))
        recovered = self.task(task["taskId"])
        self.assertEqual(recovered["status"], "completed")
        self.assertIsNone(recovered.get("pendingRequest"))
        self.assertIn(QUESTION, recovered["recoveryNote"])
        self.assert_resolve_rejected(task)
        self.assertEqual(self.messages(task)[0]["text"], "已核对并完成")

    def test_turn_completion_retires_pending_input_and_rejects_late_resolve(self):
        task, executor = self.start("ask")
        self.pending_input(task, executor)
        final = self.finish(task, executor)
        self.assertEqual(final["status"], "completed")
        self.assertIsNone(final.get("pendingRequest"))
        self.assertIn(QUESTION, final["recoveryNote"])
        self.assert_resolve_rejected(task)
        self.assertTrue(executor.request_replies.empty())

    def test_invalid_continue_model_preserves_interrupted_task_and_starts_no_worker(self):
        task, executor = self.start("ask", model="original-model")
        self.runtime.control(task["taskId"], "stop")
        self.finish(task, executor)
        before = self.task(task["taskId"])
        sequence = self.service.store.snapshot()["sequence"]
        for model in ([], {}, 123):
            with self.subTest(model=model), self.assertRaises(StoreError) as caught:
                self.runtime.control(task["taskId"], "continue", {"model": model})
            self.assertEqual(caught.exception.code, "invalid_parameter")
            self.assertEqual(self.task(task["taskId"]), before)
            self.assertEqual(self.service.store.snapshot()["sequence"], sequence)
            self.assertEqual(len(self.factory.instances), 1)

    def test_material_edit_forwards_command_metadata_and_retry_keeps_resolved_prompt(self):
        self.service.apply_command({"operationId": "OP-MASTERED", "actor": "student", "kind": "review",
            "generation": 1, "expectedRevisions": {f"review:{UNIT}": 0},
            "changes": [{"namespace": "review", "key": UNIT, "value": {"status": "mastered"}}]})
        task, executor = self.start()
        args = {**self.edit_args(self.read(executor)), "materialChange": True,
                "materialReason": "主结论解释发生实质变化"}
        saved = self.edit(executor, args)
        self.finish(task, executor)
        with self.service.store._transaction() as db:
            command = json.loads(db.execute("SELECT payload_json FROM operations WHERE operation_id=?",
                                            (saved["operationId"],)).fetchone()[0])
        self.assertIs(command.get("materialChange"), True)
        self.assertEqual(command.get("materialReason"), "主结论解释发生实质变化")
        prompt_id = "PROMPT-" + digest([UNIT, saved["operationId"]])
        prompt = self.service.store.read("reviewPrompts", prompt_id)
        self.assertEqual(prompt["revision"], 1, "One material edit must create one prompt")
        self.assertEqual(prompt["value"]["reason"], "主结论解释发生实质变化")
        self.runtime.resolve_mastery(prompt_id, "keep")
        resolved = self.service.store.read("reviewPrompts", prompt_id)
        self.assertTrue(resolved["value"]["resolved"])
        self.service.apply_command(command)  # The central service also handles saved retries.
        self.assertEqual(self.service.store.read("reviewPrompts", prompt_id), resolved)
        self.assertEqual(self.runtime.state()["prompts"], [])

    def test_material_command_retry_can_fill_a_missing_prompt_after_prompt_save_failed(self):
        self.service.apply_command({"operationId": "OP-MASTERED", "actor": "student", "kind": "review",
            "generation": 1, "expectedRevisions": {f"review:{UNIT}": 0},
            "changes": [{"namespace": "review", "key": UNIT, "value": {"status": "mastered"}}]})
        task, executor = self.start()
        args = {**self.edit_args(self.read(executor)), "materialChange": True, "materialReason": "需复查方法"}
        self.sql("CREATE TRIGGER fail_mastery_prompt BEFORE INSERT ON documents "
                 "WHEN NEW.namespace='reviewPrompts' BEGIN SELECT RAISE(ABORT,'prompt save failed'); END")
        try:
            result, success = executor.tool("review_edit", args)
            self.assertFalse(success, result)
            self.assertEqual(result["error"]["code"], "save_failed")
            self.assertEqual(self.block_text(), "Agent 补充说明")
            self.assertEqual(self.service.store.list("reviewPrompts"), {})
        finally:
            self.sql("DROP TRIGGER fail_mastery_prompt")
        operation_id = self.knowledge_events()[0]["operationId"]
        with self.service.store._transaction() as db:
            command = json.loads(db.execute("SELECT payload_json FROM operations WHERE operation_id=?",
                                            (operation_id,)).fetchone()[0])
        self.assertIs(command.get("materialChange"), True)
        self.edit(executor, args)  # A tool retry must reach the service's saved-command hook too.
        prompt = self.service.store.read("reviewPrompts", "PROMPT-" + digest([UNIT, operation_id]))
        self.assertEqual(prompt["revision"], 1)
        self.assertEqual(prompt["value"]["reason"], "需复查方法")
        self.assertEqual(len(self.knowledge_events()), 1)
        self.finish(task, executor)

    def test_course_write_queue_crosses_conversations_but_ask_runs_and_target_stays_fixed(self):
        first, first_executor = self.start()
        second_chat = self.runtime.conversation()["conversationId"]
        request = self.request(conversationId=second_chat)
        second = self.runtime.submit(request)
        # Mutate the caller's object and the saved UI selection after enqueueing.
        request["target"]["objectId"] = "KU-055"
        request["target"]["text"] = "另一个选段"
        self.service.apply_command({"operationId": "OP-NAVIGATION", "actor": "student",
            "kind": "reading", "generation": 1, "expectedRevisions": {"reading:default": 0},
            "changes": [{"namespace": "reading", "key": "default",
                         "value": {"selected": "KU-055", "mode": "detail"}}]})
        self.student_edit(CORE, "排队期间的最新正文")
        ask = self.runtime.submit(self.request("ask", conversationId=second_chat))
        ask_executor = self.factory.get(1)
        self.assertEqual(ask_executor.context["requestKind"], "ask")
        self.finish(ask, ask_executor, "问答无需等待修改")
        self.assertEqual(self.task(second["taskId"])["status"], "queued")
        self.assertEqual(len(self.factory.instances), 2)
        self.finish(first, first_executor)
        second_executor = self.factory.get(2)
        self.assertEqual(second_executor.context["fixedTarget"], second["target"])
        self.assertEqual(second_executor.context["fixedTarget"]["objectId"], UNIT)
        self.assertEqual(second_executor.context["fixedTarget"]["text"], "提交时固定选段")
        core = next(b for b in second_executor.context["currentEntity"]["reading"]["blocks"] if b["id"] == CORE)
        self.assertEqual(core["payload"]["text"], "排队期间的最新正文")
        self.finish(second, second_executor)

    def test_accepted_student_notice_and_different_block_merge_preserve_both_edits(self):
        task, executor = self.start()
        base = self.read(executor)
        student = self.student_edit()
        notice = executor.steers.get(timeout=TIMEOUT)
        self.assertIn("学生最新说明", notice)
        self.wait_task(task["taskId"], lambda t: any(c.get("accepted") for c in t["concurrentEdits"]))
        saved = self.edit(executor, self.edit_args(base))
        final = self.finish(task, executor)
        self.assertEqual(self.block_text(CORE), "Agent 补充说明")
        self.assertEqual(self.block_text(WARNING), "学生最新说明")
        self.assertEqual(final["status"], "completed")
        self.assertEqual(final["operationIds"], [saved["operationId"]])
        self.assertEqual(final["concurrentEdits"][0]["operationId"], student["operationId"])
        self.assertTrue(final["concurrentEdits"][0]["accepted"])
        self.assertIn(UNIT, self.messages(task)[0]["text"])

    def test_accepted_notice_does_not_bypass_same_block_cas(self):
        task, executor = self.start()
        base = self.read(executor)
        self.student_edit(CORE, "学生拥有此段的新版本")
        executor.steers.get(timeout=TIMEOUT)
        self.wait_task(task["taskId"], lambda t: any(c.get("accepted") for c in t["concurrentEdits"]))
        result, success = executor.tool("review_edit", self.edit_args(base))
        self.assertFalse(success, result)
        self.assertEqual(result["error"]["code"], "revision_conflict")
        self.assertEqual(result["error"]["details"]["blockId"], CORE)
        final = self.finish(task, executor, "此段已有修改，需要核对")
        self.assertEqual(final["status"], "needs_input")
        self.assertEqual(final["operationIds"], [])
        self.assertEqual(self.block_text(), "学生拥有此段的新版本")

    def test_failed_notice_is_recorded_and_not_claimed_as_accepted(self):
        self.factory.options["steer_error"] = StoreError("executor_unavailable", "turn/steer 未确认")
        task, executor = self.start()
        self.read(executor)
        self.student_edit()
        executor.steers.get(timeout=TIMEOUT)
        final = self.wait_task(task["taskId"], lambda t: any(c.get("error") for c in t["concurrentEdits"]))
        self.assertFalse(final["concurrentEdits"][0]["accepted"])
        # Reading the new record explicitly synchronizes the peer despite failed steer.
        self.edit(executor, self.edit_args(self.read(executor)))
        self.finish(task, executor)
        self.assertEqual(self.block_text(WARNING), "学生最新说明")
        self.assertIn("通知未确认", self.messages(task)[0]["text"])

    def test_restore_changes_generation_and_rejects_old_running_submission(self):
        task, executor = self.start()
        base = self.read(executor)
        saved = self.edit(executor, self.edit_args(base))
        late = self.edit_args(self.read(executor), text="旧代际的迟到修改")
        before_sequence = self.service.store.snapshot()["sequence"]
        restored = self.service.content.restore(0)
        self.assertGreater(restored["generation"], base["generation"])
        self.assertGreater(restored["sequence"], before_sequence)
        restored_text = self.block_text()
        # Test the generation guard itself before the HTTP layer's interrupt notification.
        result, success = executor.tool("review_edit", late)
        self.assertFalse(success, result)
        self.assertEqual(result["error"]["code"], "revision_conflict")
        self.assertEqual(self.block_text(), restored_text)
        self.runtime.invalidate_generation()
        self.assertTrue(executor.interrupted.wait(TIMEOUT))
        final = self.finish(task, executor)
        self.assertEqual(final["status"], "interrupted")
        self.assertEqual(final["operationIds"], [saved["operationId"]])
        self.assertEqual(self.service.store.snapshot()["generation"], restored["generation"])

    def test_restart_keeps_commits_does_not_rerun_until_continue_then_only_adds_remaining_work(self):
        request = self.request()
        task = self.runtime.submit(request)
        executor = self.factory.get()
        saved = self.edit(executor, self.edit_args(self.read(executor)))
        self.reopen()
        probe = self.factory.get(started=False)
        self.assertTrue(probe.closed.wait(TIMEOUT))
        recovered = self.wait_task(task["taskId"], lambda t: t["status"] == "needs_input")
        self.assertFalse(probe.started.is_set(), "Recovery must query, never start another turn")
        self.assertEqual(len(self.factory.instances), 1)
        self.assertEqual(recovered["operationIds"], [saved["operationId"]])
        self.assertEqual(self.block_text(), "Agent 补充说明")
        self.assertEqual(self.runtime.submit(request)["taskId"], task["taskId"])
        self.runtime.control(task["taskId"], "continue")
        resumed = self.factory.get(1)
        self.assertEqual(resumed.context["alreadyCommittedOperationIds"], [saved["operationId"]])
        self.assertEqual(resumed.context["fixedTarget"], task["target"])
        remaining = self.edit(resumed, self.edit_args(self.read(resumed), WARNING, "继续后仅补剩余说明"))
        final = self.finish(task, resumed)
        self.assertEqual(final["operationIds"], [saved["operationId"], remaining["operationId"]])
        self.assertEqual(len(self.knowledge_events()), 2)
        self.assertEqual(self.block_text(), "Agent 补充说明")
        self.assertEqual(self.block_text(WARNING), "继续后仅补剩余说明")

    def test_reconcile_recovers_completed_answer_without_starting_another_turn(self):
        task, executor = self.start("ask")
        actual = {"thread": {"turns": [{"id": executor.turn_id, "status": "completed", "items": [
            {"id": "answer", "type": "agentMessage", "phase": "final_answer", "text": "执行器已完成的真实回答"}]}]}}
        # Completion exists at the peer, but its notification was never delivered.
        self.reopen(actual=actual)
        probe = self.factory.get(started=False)
        self.assertTrue(probe.closed.wait(TIMEOUT))
        self.assertFalse(probe.started.is_set())
        self.assertEqual(self.task(task["taskId"])["reconciledExecutorStatus"], "completed")
        messages = self.messages(task)
        self.assertEqual([m["text"] for m in messages], ["执行器已完成的真实回答"])
        self.assertEqual(self.task(task["taskId"])["status"], "completed")

    def test_disconnect_keeps_partial_output_instead_of_replacing_it_with_error(self):
        task, executor = self.start("ask")
        executor.emit("item/agentMessage/delta", itemId="answer", delta="已经输出的解释，断线后仍应保留。")
        self.read(executor)  # Guarantees the first delta was consumed and persisted.
        self.assertIn("已经输出的解释", self.messages(task)[0]["text"])
        executor.emit("connection/closed")
        probe = self.factory.get(1, started=False)
        self.assertTrue(probe.closed.wait(TIMEOUT))
        self.wait_task(task["taskId"], lambda t: t["status"] == "needs_input")
        self.assertIn("已经输出的解释", self.messages(task)[0]["text"])
        self.reopen()
        self.assertIn("已经输出的解释", self.messages(task)[0]["text"])

    def test_cli_unavailable_has_explicit_failure_and_does_not_change_knowledge(self):
        self.factory.options["connect_error"] = StoreError("executor_unavailable", "未找到 Codex CLI")
        before = self.service.content.get(UNIT)
        task = self.runtime.submit(self.request("ask"))
        executor = self.factory.get(started=False)
        self.assertTrue(executor.closed.wait(TIMEOUT))
        final = self.task(task["taskId"])
        self.assertEqual(final["status"], "failed")
        self.assertEqual(final["error"]["code"], "executor_unavailable")
        self.assertFalse(executor.started.is_set())
        self.assertEqual(self.service.content.get(UNIT), before)
        self.assertIn("Codex CLI", self.messages(task)[0]["text"])

    def test_unresolved_conflict_after_partial_commit_still_needs_input(self):
        task, executor = self.start()
        saved = self.edit(executor, self.edit_args(self.read(executor)))
        base = self.read(executor)
        self.student_edit(WARNING, "学生正在修改第二段")
        executor.steers.get(timeout=TIMEOUT)
        self.wait_task(task["taskId"], lambda t: any(c.get("accepted") for c in t["concurrentEdits"]))
        result, success = executor.tool("review_edit", self.edit_args(base, WARNING, "冲突覆盖"))
        self.assertFalse(success, result)
        self.assertEqual(result["error"]["code"], "revision_conflict")
        final = self.finish(task, executor, "第一段已保存，第二段冲突仍需学生确认")
        self.assertEqual(final["operationIds"], [saved["operationId"]])
        self.assertEqual(self.block_text(), "Agent 补充说明")
        self.assertEqual(self.block_text(WARNING), "学生正在修改第二段")
        self.assertEqual(final["status"], "needs_input", "A partial commit does not resolve the remaining conflict")

    def test_failed_task_save_keeps_draft_and_review_and_same_request_can_retry(self):
        chat = self.runtime.conversation()
        self.runtime.save_conversation(chat["conversationId"], {"draft": "未发送草稿，保存失败不能丢"})
        self.service.apply_command({"operationId": "OP-REVIEW", "actor": "student", "kind": "review",
            "generation": 1, "expectedRevisions": {f"review:{UNIT}": 0},
            "changes": [{"namespace": "review", "key": UNIT, "value": {"status": "weak"}}]})
        request = self.request(conversationId=chat["conversationId"])
        before = self.service.content.get(UNIT)
        self.sql("CREATE TRIGGER fail_task_save BEFORE INSERT ON documents "
                 "WHEN NEW.namespace='tasks' BEGIN SELECT RAISE(ABORT,'disk full: task'); END")
        try:
            with self.assertRaises(StoreError) as caught:
                self.runtime.submit(request)
            self.assertEqual(caught.exception.code, "save_failed")
            self.assertEqual(self.runtime.conversation(chat["conversationId"])["draft"], "未发送草稿，保存失败不能丢")
            self.assertEqual(self.service.store.read("review", UNIT)["value"], {"status": "weak"})
            self.assertEqual(self.service.content.get(UNIT), before)
            self.assertEqual(len(self.factory.instances), 0)
        finally:
            self.sql("DROP TRIGGER fail_task_save")
        retry = self.runtime.submit(request)
        self.assertIsNotNone(self.task(retry["taskId"]), "Retry returned a cache-only task that was never saved")
        executor = self.factory.get()
        self.finish(retry, executor)

    def test_failed_content_commit_keeps_draft_review_and_knowledge_then_retries_once(self):
        task, executor = self.start()
        chat_id = task["conversationId"]
        self.runtime.save_conversation(chat_id, {"draft": "下一条尚未发送的问题"})
        self.service.apply_command({"operationId": "OP-REVIEW", "actor": "student", "kind": "review",
            "generation": 1, "expectedRevisions": {f"review:{UNIT}": 0},
            "changes": [{"namespace": "review", "key": UNIT, "value": {"status": "mastered"}}]})
        base = self.read(executor)
        args = self.edit_args(base)
        before = (self.root / "期中/数据/知识地图.json").read_bytes()
        self.sql("CREATE TRIGGER fail_agent_commit BEFORE INSERT ON operations "
                 "WHEN NEW.operation_id LIKE 'OP-AGENT-%' "
                 "BEGIN SELECT RAISE(ABORT,'disk full: knowledge'); END")
        try:
            result, success = executor.tool("review_edit", args)
            self.assertFalse(success, result)
            self.assertEqual(result["error"]["code"], "save_failed")
            self.assertEqual((self.root / "期中/数据/知识地图.json").read_bytes(), before)
            self.assertEqual(self.service.content.get(UNIT), base)
            self.assertEqual(self.runtime.conversation(chat_id)["draft"], "下一条尚未发送的问题")
            self.assertEqual(self.service.store.read("review", UNIT)["value"], {"status": "mastered"})
            self.assertEqual(self.task(task["taskId"])["operationIds"], [])
            self.assertEqual(self.knowledge_events(), [])
        finally:
            self.sql("DROP TRIGGER fail_agent_commit")
        saved = self.edit(executor, args)
        final = self.finish(task, executor)
        self.assertEqual(final["operationIds"], [saved["operationId"]])
        self.assertEqual(len(self.knowledge_events()), 1)
        self.reopen()
        self.assertEqual(self.block_text(), "Agent 补充说明")
        self.assertEqual(self.runtime.conversation(chat_id)["draft"], "下一条尚未发送的问题")
        self.assertEqual(self.service.store.read("review", UNIT)["value"], {"status": "mastered"})

    def test_restart_recovers_commit_ledger_when_task_record_save_failed_after_commit(self):
        task, executor = self.start()
        args = self.edit_args(self.read(executor))
        self.sql("CREATE TRIGGER fail_commit_mapping BEFORE UPDATE ON documents "
                 "WHEN NEW.namespace='tasks' AND json_array_length(NEW.value_json,'$.operationIds')>0 "
                 "BEGIN SELECT RAISE(ABORT,'disk full: task mapping'); END")
        try:
            result, success = executor.tool("review_edit", args)
            self.assertFalse(success, result)
            self.assertEqual(result["error"]["code"], "save_failed")
            self.assertEqual(self.block_text(), "Agent 补充说明")
            commits = self.knowledge_events()
            self.assertEqual(len(commits), 1)
            committed_id = commits[0]["operationId"]
            self.assertEqual(self.task(task["taskId"])["operationIds"], [])
        finally:
            self.sql("DROP TRIGGER fail_commit_mapping")
        # No more executor event is delivered before shutdown; the missing mapping
        # can only be recovered from durable facts, never the old task cache.
        self.reopen()
        probe = self.factory.get(started=False)
        self.assertTrue(probe.closed.wait(TIMEOUT))
        recovered = self.wait_task(task["taskId"], lambda t: t["status"] == "needs_input")
        self.assertFalse(probe.started.is_set())
        self.assertEqual(self.block_text(), "Agent 补充说明")
        self.assertEqual(recovered["operationIds"], [committed_id],
                         "Recovery forgot a durable knowledge commit because its task record lagged")
        self.runtime.control(task["taskId"], "continue")
        resumed = self.factory.get(1)
        self.assertEqual(resumed.context["alreadyCommittedOperationIds"], [committed_id])
        self.finish(task, resumed)
        self.assertEqual(len(self.knowledge_events()), 1)

    def test_completed_item_is_not_extended_by_delayed_delta(self):
        task, executor = self.start("ask")
        executor.emit("item/agentMessage/delta", itemId="answer", delta="完整")
        executor.emit("item/completed", item={"id": "answer", "type": "agentMessage", "text": "完整回答"})
        executor.emit("item/agentMessage/delta", itemId="answer", delta="回答")
        # A read/reply is a barrier: the preceding stream has been consumed.
        self.read(executor)
        self.finish(task, executor, text=None)
        self.assertEqual(len(self.messages(task)), 1)
        self.assertEqual(self.messages(task)[0]["text"], "完整回答")


if __name__ == "__main__":
    unittest.main()
