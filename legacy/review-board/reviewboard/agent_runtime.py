"""Durable learning requests, one course write queue and explicit task recovery."""
from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import json
import threading
import time
import uuid

from .codex_executor import CodexExecutor
from .semantic_components import component_contracts
from .storage import StoreError


ACTIVE = {"queued", "running", "needs_input", "reconciling"}
KINDS = {"ask", "edit", "search", "update_sources"}


def now():
    return datetime.now(timezone.utc).isoformat()


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                    separators=(",", ":")).encode()).hexdigest()


def blocks(entity):
    result = {}
    def walk(items):
        for item in items:
            result[item["id"]] = item
            walk(item.get("children", []))
    walk(entity.get("reading", {}).get("blocks", []))
    return result


class AgentRuntime:
    def __init__(self, service, executor_factory=CodexExecutor):
        self.service, self.factory = service, executor_factory
        self._lock = threading.RLock()
        self._write_queue = threading.Lock()
        self._executors = {}
        self._workers = []
        self._closed = False
        self._task_cache = {}
        for key, record in service.store.list("tasks").items():
            task = record["value"]
            if not task:
                continue
            self._task_cache[key] = task
            if task["status"] in ACTIVE:
                task["status"] = "reconciling"
                task["recoveryNote"] = self._retire_pending_request(
                    task, "服务已重开，正在核对已保存的结果；不会自动重跑。")
                self._put("tasks", key, task)
            elif task.get("pendingRequest"):
                task["recoveryNote"] = self._retire_pending_request(
                    task, task.get("recoveryNote", "原执行轮次已结束，已保存内容仍保留。"))
                self._put("tasks", key, task)
        if any(t["status"] == "reconciling" for t in self._task_cache.values()):
            self._spawn(self._reconcile_pending)

    def _spawn(self, target, *args):
        thread = threading.Thread(target=target, args=args, daemon=True)
        self._workers.append(thread)
        thread.start()

    def _put(self, namespace, key, value, kind="agent.record", operation_id=None):
        # Execution facts use the same store/transaction/event ledger, never a second task file.
        with self.service._command_lock:
            record = self.service.store.read(namespace, key)
            snap = self.service.store.snapshot()
            return self.service.store.apply({
                "operationId": operation_id or "OP-" + str(uuid.uuid4()),
                "actor": "agent", "kind": kind, "generation": snap["generation"],
                "changes": [{"namespace": namespace, "key": key, "value": deepcopy(value)}],
                "expectedRevisions": {f"{namespace}:{key}": record["revision"]}})

    def _save_task(self, task):
        task["updatedAt"] = now()
        self._put("tasks", task["taskId"], task)

    @staticmethod
    def _retire_pending_request(task, note):
        """Keep the question as history, never a reply handle for another connection."""
        request = task.pop("pendingRequest", None)
        if request:
            task["previousPendingRequest"] = deepcopy(request)
        previous = task.get("previousPendingRequest")
        if previous:
            params = previous.get("params", {})
            questions = [q.get("question") or q.get("header") for q in params.get("questions", [])
                         if isinstance(q, dict)]
            text = "；".join(q for q in questions if isinstance(q, str) and q)
            if not text:
                text = params.get("reason") or params.get("command") or previous["method"]
                if not isinstance(text, str):
                    text = json.dumps(text, ensure_ascii=False)
            note += "\n上次待处理信息（原执行器请求已失效）：" + text
        return note

    def _records(self, changes, kind):
        with self.service._command_lock:
            snapshot = self.service.store.snapshot()
            return self.service.store.apply({"operationId": "OP-" + str(uuid.uuid4()),
                "actor": "agent", "kind": kind, "generation": snapshot["generation"], "changes": changes,
                "expectedRevisions": {f"{c['namespace']}:{c['key']}": self.service.store.read(
                    c["namespace"], c["key"])["revision"] for c in changes}})

    def _recover_commits(self, task):
        """Content's durable command ledger is also the task/commit association."""
        with self.service.store._transaction() as db:
            rows = db.execute("SELECT payload_json,result_json FROM operations "
                              "WHERE operation_id LIKE 'OP-AGENT-%' ORDER BY rowid").fetchall()
        found = []
        for payload, receipt in rows:
            command = json.loads(payload)
            if command.get("taskId") == task["taskId"]:
                found.append(json.loads(receipt)["operationId"])
        task["operationIds"] = list(dict.fromkeys(task.get("operationIds", []) + found))

    def state(self):
        self._observe_sources()
        snap = self.service.store.snapshot()
        docs = snap["documents"]
        return {"tasks": [r["value"] for r in docs.get("tasks", {}).values() if r["value"]],
                "conversations": [r["value"] for r in docs.get("conversations", {}).values() if r["value"]],
                "prompts": [dict(r["value"], revision=r["revision"])
                            for r in docs.get("reviewPrompts", {}).values()
                            if r["value"] and not r["value"].get("resolved")],
                "ui": docs.get("agent_ui", {}).get("default", {}).get("value") or {},
                "sourceUpdates": [r["value"] for r in docs.get("materialUpdates", {}).values()
                                  if r["value"] and r["value"].get("status") == "pending"],
                "sequence": snap["sequence"], "generation": snap["generation"]}

    def _observe_sources(self):
        with self._lock:
            sources = self.service.catalog.store().sources
            current = {sid: [v["id"] for v in src.get("versions", [])] for sid,src in sources.items()}
            previous = self.service.store.read("sourceTracking", "observed")["value"]
            if previous is not None:
                for source_id, versions in current.items():
                    for version_id in set(versions) - set(previous.get(source_id, [])):
                        src = sources[source_id]
                        version = next(v for v in src["versions"] if v["id"] == version_id)
                        affected = [uid for uid in sorted(self.service.catalog.unit_ids())
                                    if any(r.get("sourceId") == source_id for r in self.service.catalog.get(uid).get("sourceRefs", []))]
                        identifier = "UPDATE-" + digest([source_id, version_id])
                        if self.service.store.read("materialUpdates", identifier)["value"] is not None:
                            continue
                        self._put("materialUpdates", identifier, {"updateId": identifier,
                            "sourceId": source_id, "versionId": version_id,
                            "displayName": version["displayName"], "status": "pending",
                            "affectedUnitIds": affected, "createdAt": now()})
            if previous != current:
                self._put("sourceTracking", "observed", current)

    def material_decision(self, identifier, action, conversation_id=None):
        if not isinstance(identifier,str):
            raise StoreError("invalid_parameter", "资料更新身份无效")
        with self._lock:
            value = self.service.store.read("materialUpdates", identifier)["value"]
            if not value:
                raise StoreError("not_found", "找不到资料更新提示")
            if not isinstance(action,str) or action not in {"later", "update"}:
                raise StoreError("invalid_parameter", "未知资料更新选择")
            if action == "update":
                if not value["affectedUnitIds"]:
                    raise StoreError("invalid_content", "资料尚未关联现有单元，请先指定要更新的目标")
                version = next(v for v in self.service.catalog.store().sources[value["sourceId"]]["versions"]
                               if v["id"] == value["versionId"])
                result = self.submit({"requestId": "REQ-" + identifier, "conversationId": conversation_id,
                    "target": {"objectId": value["affectedUnitIds"][0]}, "requestKind": "update_sources",
                    "sourceSelection": {"sourceId": value["sourceId"], "versionId": value["versionId"],
                                        "location": {"pdfPage": 1} if version["totalPages"] else {"section": "全文"}},
                    "instruction": "根据明确的新资料版本 " + value["versionId"] + " 核对并更新直接相关单元 " +
                                   "、".join(value["affectedUnitIds"]) + "。保留旧来源引用，说明版本差异。修改直接生效且可撤回；不改无关单元。"})
                value["taskId"] = result["taskId"]
            else:
                result = {"saved": True, "decision": "later", "note": "画板与旧引用保持，新版资料仍可回查。"}
            value["status"] = action
            self._put("materialUpdates", identifier, value)
            return result

    def conversation(self, identifier=None):
        if identifier is not None and (not isinstance(identifier,str) or not identifier):
            raise StoreError("invalid_parameter", "学习对话身份无效")
        with self._lock:
            if identifier:
                value = self.service.store.read("conversations", identifier)["value"]
                if value is None:
                    raise StoreError("not_found", "找不到学习对话")
                return value
            identifier = "CHAT-" + str(uuid.uuid4())
            value = {"conversationId": identifier, "title": "新的学习对话", "messages": [],
                     "createdAt": now(), "updatedAt": now(), "draft": ""}
            self._put("conversations", identifier, value)
            return value

    def save_conversation(self, identifier, patch):
        with self._lock:
            value = self.conversation(identifier)
            if not isinstance(patch,dict) or set(patch) - {"draft", "title"} or any(not isinstance(v, str) for v in patch.values()):
                raise StoreError("invalid_parameter", "对话仅可保存草稿和标题")
            value.update(patch)
            value["updatedAt"] = now()
            self._put("conversations", identifier, value)
            return value

    def _message(self, task, text, *, pending=False):
        with self._lock:
            conversation = self.conversation(task["conversationId"])
            identifier = "MSG-" + task["taskId"]
            message = next((m for m in conversation["messages"] if m["messageId"] == identifier), None)
            if message is None:
                message = {"messageId": identifier, "role": "assistant", "taskId": task["taskId"],
                           "createdAt": now()}
                conversation["messages"].append(message)
            message.update({"text": text, "pending": pending,
                            "sourceSelection": task.get("sourceSelection"),
                            "sourceCitations": task.get("sourceCitations", []),
                            "target": task["target"], "operationIds": task["operationIds"]})
            conversation["updatedAt"] = now()
            self._put("conversations", conversation["conversationId"], conversation)

    def submit(self, request):
        if not isinstance(request, dict):
            raise StoreError("invalid_parameter", "学习请求必须是对象")
        instruction, kind = request.get("instruction"), request.get("requestKind", "ask")
        if not isinstance(instruction, str) or not instruction.strip() or len(instruction) > 30_000:
            raise StoreError("invalid_parameter", "请输入具体问题或修改要求")
        if not isinstance(kind, str) or kind not in KINDS:
            raise StoreError("invalid_parameter", "未知学习请求类型")
        operation = request.get("requestId")
        if not isinstance(operation, str) or not operation.startswith("REQ-") or len(operation)>200:
            raise StoreError("invalid_parameter", "请求缺少稳定 requestId")
        if request.get("model") is not None and (not isinstance(request["model"], str) or len(request["model"])>200):
            raise StoreError("invalid_parameter", "模型身份无效")
        if request.get("conversationId") is not None and not isinstance(request["conversationId"], str):
            raise StoreError("invalid_parameter", "学习对话身份无效")
        with self._lock:
            for task in self._task_cache.values():
                if task["requestId"] == operation:
                    if task["requestHash"] != digest(request):
                        raise StoreError("invalid_parameter", "请求身份已用于其他内容")
                    return deepcopy(task)
            target = deepcopy(request.get("target"))
            if not isinstance(target, dict) or not isinstance(target.get("objectId"), str):
                raise StoreError("invalid_parameter", "请先选择课程对象")
            entity = self.service.catalog.get(target["objectId"])
            self.service._unit(target["objectId"])
            text = target.get("text")
            if text is not None and (not isinstance(text, str) or len(text) > 30_000):
                raise StoreError("invalid_parameter", "选段无效")
            selection = request.get("sourceSelection")
            if selection is not None:
                if not isinstance(selection, dict):
                    raise StoreError("invalid_parameter", "原文选段无效")
                if any(not isinstance(selection.get(key),str) for key in ("sourceId","versionId")) or not isinstance(selection.get("location"),dict):
                    raise StoreError("invalid_parameter", "原文选段缺少来源版本与位置")
                selection = self.service.sources.selection(selection.get("sourceId"), selection.get("versionId"),
                              selection.get("location"), selection.get("text"))
            conversation = self.conversation(request.get("conversationId"))
            task = {"taskId": "TASK-" + str(uuid.uuid4()), "requestId": operation,
                    "requestHash": digest(request), "conversationId": conversation["conversationId"],
                    "requestKind": kind, "instruction": instruction.strip(), "target": target,
                    "submittedEntity": entity, "sourceSelection": selection,
                    "status": "queued", "queueOrder": self.service.store.snapshot()["sequence"],
                    "generation": self.service.store.snapshot()["generation"],
                    "operationIds": [], "concurrentEdits": [], "executor": {},
                    "createdAt": now(), "model": request.get("model") or None, "attempt": 0}
            conversation["messages"].append({"messageId": "USER-" + task["taskId"], "role": "user",
                "text": instruction.strip(), "taskId": task["taskId"], "target": target,
                "sourceSelection": selection, "createdAt": now()})
            if len(conversation["messages"]) == 1:
                conversation["title"] = instruction[:24]
            conversation["draft"] = ""
            conversation["updatedAt"] = now()
            task["updatedAt"] = now()
            self._records([{"namespace": "tasks", "key": task["taskId"], "value": task},
                           {"namespace": "conversations", "key": conversation["conversationId"], "value": conversation}],
                          "agent.submit")
            # Publish and start only after both request and user message are durable.
            self._task_cache[task["taskId"]] = task
            self._spawn(self._run, task["taskId"])
            return deepcopy(task)

    def _context(self, task):
        unit = self.service.catalog.get(task["target"]["objectId"])
        conversation = self.conversation(task["conversationId"])
        history = [{"role": m["role"], "text": m.get("text", "")}
                   for m in conversation["messages"][-18:] if m.get("taskId") != task["taskId"]]
        result = {"requestKind": task["requestKind"], "fixedTarget": task["target"],
                  "currentEntity": unit, "sourceSelection": task.get("sourceSelection"),
                  "conversation": history, "instruction": task["instruction"],
                  "alreadyCommittedOperationIds": task["operationIds"],
                  "resumeNote": task.get("resumeNote"),
                  "supportedComponents": component_contracts(),
                  "rules": "问答只回答；修改直接写入工具。保留已提交操作，只补剩余意图。"}
        result["sourceVersions"] = [{"sourceId": sid, "versions": src.get("versions", [])}
                                    for sid,src in self.service.catalog.store().sources.items()]
        selection = task.get("sourceSelection")
        if selection:
            result["sourceContent"] = self.service.sources.resolve(selection["sourceId"],
                                       selection["versionId"], selection["location"])
            task.setdefault("sourceCitations", [{key:selection[key] for key in ("sourceId","versionId","location","displayName")}])
        if task["requestKind"] == "search":
            result["existingKnowledge"] = [{"id": uid, "name": self.service.catalog.get(uid).get("name"),
                "summary": self.service.catalog.get(uid).get("summary")}
                for uid in sorted(self.service.catalog.unit_ids())]
            snapshot = self.service.store.snapshot()["documents"]
            result["existingNotes"] = [{"id": key, **row["value"]} for key,row in snapshot.get("notes", {}).items() if row["value"]]
            result["existingConversations"] = [{"id": key, "title": row["value"].get("title"),
                "messages": row["value"].get("messages", [])[-8:]} for key,row in snapshot.get("conversations", {}).items() if row["value"]]
            result["searchRule"] = "调用 review_locate 返回确有内容的定位。无命中调用空 hits。新解释只进回答，不能冒充命中。"
        return json.dumps(result, ensure_ascii=False)

    def _run(self, identifier):
        task = self._task_cache[identifier]
        writing = task["requestKind"] in {"edit", "update_sources"}
        locked = False
        executor = None
        try:
            if writing:
                while not self._closed:
                    with self._lock:
                        if task["status"] != "queued":
                            return
                        earlier = any(t["taskId"] != identifier and t["requestKind"] in {"edit", "update_sources"}
                            and t["status"] in {"queued", "running", "needs_input", "reconciling"}
                            and (t["queueOrder"], t["createdAt"]) < (task["queueOrder"], task["createdAt"])
                            for t in self._task_cache.values())
                    if not earlier and self._write_queue.acquire(timeout=.15):
                        locked = True
                        break
                    time.sleep(.05)
            with self._lock:
                if self._closed or task["status"] != "queued":
                    return
                if self.service.store.snapshot()["generation"] != task["generation"]:
                    raise StoreError("revision_conflict", "课程已回退，请核对目标后点击继续")
                task["status"], task["startedAt"] = "running", now()
                task["attempt"] += 1
                task["executor"] = {}
                task.setdefault("executions", []).append({"attempt": task["attempt"], "startedAt": task["startedAt"]})
                task["startEntity"] = self.service.catalog.get(task["target"]["objectId"])
                task["reads"] = {}
                self._save_task(task)
            executor = self.factory(self.service.root, task.get("model"))
            self._executors[identifier] = executor
            executor.connect()
            with self._lock:
                if self._closed or task["status"] == "interrupted":
                    return
            selection = task.get("sourceSelection")
            if selection and selection.get("location", {}).get("pdfPage"):
                executor.image_paths = [self.service.sources.page_image(selection["sourceId"],
                    selection["versionId"], selection["location"]["pdfPage"])]
            def mapping(update):
                with self._lock:
                    task["executor"].update(update)
                    task["executions"][-1].update(update)
                    self._save_task(task)
                    if task["status"] == "interrupted":
                        if update.get("turnId"):
                            self._spawn(self._interrupt, executor)
                        else:
                            raise StoreError("interrupted", "任务已停止，未启动新的执行")
            executor.start(self._context(task), mapping)
            pieces, finals, completed_items = {}, {}, set()
            last_flush = 0
            while not self._closed:
                event = executor.next_event()
                if event is None:
                    continue
                method, params = event.get("method"), event.get("params", {})
                if method == "connection/closed":
                    raise StoreError("executor_unavailable", "连接断开，需要核对实际任务状态")
                if method == "item/agentMessage/delta":
                    item = params.get("itemId", "answer")
                    if item in completed_items:
                        continue
                    pieces[item] = pieces.get(item, "") + params.get("delta", "")
                    if time.monotonic() - last_flush > .15:
                        self._message(task, "\n\n".join(pieces.values()), pending=True)
                        last_flush = time.monotonic()
                elif method == "item/completed" and params.get("item", {}).get("type") == "agentMessage":
                    item = params["item"]
                    completed_items.add(item["id"])
                    pieces[item["id"]] = item.get("text", "")
                    if item.get("phase") in {"final_answer", "finalAnswer"}:
                        finals[item["id"]] = item.get("text", "")
                elif method == "item/tool/call":
                    try:
                        value = self._tool(task, params["tool"], params["arguments"])
                        executor.reply_tool(event["id"], value)
                    except (StoreError, ValueError, KeyError) as exc:
                        error = {"error": {"code": getattr(exc, "code", "invalid_content"),
                                          "message": str(exc), "details": getattr(exc, "details", {})}}
                        executor.reply_tool(event["id"], error, success=False)
                        if getattr(exc, "code", None) == "revision_conflict":
                            task["lastConflict"] = error["error"]
                            task.setdefault("unresolvedConflicts", []).append(error["error"])
                            self._save_task(task)
                elif "id" in event:
                    self._permission(task, event, executor)
                elif method == "turn/completed":
                    turn = params.get("turn", {})
                    with self._lock:
                        if task["status"] != "interrupted":
                            task["status"] = {"completed": "completed", "interrupted": "interrupted",
                                              "failed": "failed"}.get(turn.get("status"), "failed")
                        if turn.get("error"):
                            task["error"] = {"code": "executor_failed", "message": str(turn["error"].get("message", "执行失败"))}
                        if task["status"] != "interrupted" and task.get("unresolvedConflicts") and writing:
                            task["status"] = "needs_input"
                        if task.get("pendingRequest"):
                            task["recoveryNote"] = self._retire_pending_request(
                                task, "本轮执行已结束，已保存结果保留；需要补做时点击继续。")
                        task["completedAt"] = now()
                        answer = "\n\n".join((finals or pieces).values())
                        if not answer:
                            answer = "任务已停止，已保存的结果仍保留。" if task["status"] == "interrupted" else "执行结束，未收到回答。"
                        if task["concurrentEdits"]:
                            notices = [f"{c['objectId']}（{'运行中通知已接收' if c.get('accepted') else '通知未确认，提交时重新核对'}）"
                                       for c in task["concurrentEdits"]]
                            answer += "\n\n同时修改记录：" + "；".join(notices) + "。学生最新内容经过提交修订核对，冲突部分未覆盖。"
                        self._message(task, answer)
                        self._save_task(task)
                    return
        except Exception as exc:
            with self._lock:
                if task["status"] != "interrupted":
                    task["status"] = "reconciling" if executor and executor.thread_id else "failed"
                if task.get("pendingRequest"):
                    task["recoveryNote"] = self._retire_pending_request(
                        task, "执行连接已结束，正在核对已保存结果；原请求不可继续答复。")
                task["error"] = {"code": getattr(exc, "code", "executor_failed"), "message": str(exc)}
                existing = self.conversation(task["conversationId"])
                partial = next((m.get("text", "") for m in existing["messages"]
                                if m.get("messageId") == "MSG-" + task["taskId"]), "")
                status_text = f"{str(exc)}。已提交的 {len(task['operationIds'])} 次修改仍保留。"
                self._message(task, partial + ("\n\n" if partial else "") + status_text)
                self._save_task(task)
        finally:
            self._executors.pop(identifier, None)
            if executor:
                executor.close()
            if locked:
                self._write_queue.release()
            if not self._closed and task["status"] == "reconciling":
                self._reconcile_one(task)

    def _tool(self, task, name, args):
        if not isinstance(args, dict):
            raise StoreError("invalid_parameter", "工具参数无效")
        if name == "review_get":
            record = self.service.content.get(args["unitId"])
            with self._lock:
                task["reads"][args["unitId"]] = deepcopy(record)
            return record
        if name == "review_search":
            return self.service.search.search(args["query"], limit=30)
        if name == "review_source":
            source = self.service.sources.resolve(args["sourceId"], args["versionId"], args["location"])
            citation = {key: source[key] for key in ("sourceId", "versionId", "location", "displayName")}
            with self._lock:
                task.setdefault("sourceCitations", [])
                if not any(all(item.get(key)==citation[key] for key in ("sourceId","versionId","location")) for item in task["sourceCitations"]):
                    task["sourceCitations"].append(citation)
                    self._save_task(task)
            if source.get("location", {}).get("pdfPage") and source.get("textStatus") == "unavailable":
                source["_imagePath"] = str(self.service.sources.page_image(source["sourceId"], source["versionId"], source["location"]["pdfPage"]))
            return source
        if name == "review_locate":
            hits = args.get("hits")
            if not isinstance(hits, list) or len(hits) > 50:
                raise StoreError("invalid_parameter", "查找命中格式无效")
            verified = []
            for hit in hits:
                scope, identifier = hit.get("scope"), hit.get("id")
                if scope == "knowledge":
                    self.service._unit(identifier)
                    entity = self.service.catalog.get(identifier)
                    verified.append({"scope": scope, "id": identifier, "name": entity["name"],
                        "snippet": entity.get("summary", ""), "location": {"unitId": identifier},
                        "version": entity.get("reading", {}).get("revision", 0)})
                elif scope in {"notes", "conversations"}:
                    entity = self.service.store.read(scope, identifier)["value"]
                    if not entity:
                        raise StoreError("not_found", "查找结果身份不存在", {"id": identifier})
                    verified.append({"scope": scope, "id": identifier,
                        "name": entity.get("title", "个人笔记"),
                        "snippet": entity.get("text", entity.get("title", "")),
                        "location": {"unitId": entity.get("objectId"), "conversationId": entity.get("conversationId")}})
                elif scope == "sources":
                    source = self.service.sources.resolve(identifier, hit.get("versionId"), hit.get("location", {}))
                    verified.append({"scope": scope, "id": identifier, "name": source["displayName"],
                        "snippet": source.get("text", "")[:240], "version": source["versionId"],
                        "location": source["location"]})
                else:
                    raise StoreError("invalid_parameter", "未知查找范围")
            with self._lock:
                task["searchHits"] = verified
                self._save_task(task)
            return {"hits": verified}
        if name != "review_edit":
            raise StoreError("capability_unavailable", "不支持此学习工具")
        operation_id = "OP-AGENT-" + digest({"task": task["taskId"], "generation": task["generation"],
            "unit": args.get("unitId"), "baseHash": args.get("baseHash"), "edits": args.get("edits")})
        with self._lock:
            with self.service.store._transaction() as db:
                prior = db.execute("SELECT payload_json FROM operations WHERE operation_id=?", (operation_id,)).fetchone()
            if prior:
                # Retry the original saved command so the service can complete
                # an interrupted post-commit prompt without applying content again.
                receipt = self.service.apply_command(json.loads(prior[0]))
                if operation_id not in task["operationIds"]:
                    task["operationIds"].append(operation_id)
                    self._save_task(task)
                return receipt
            if task["status"] != "running" or self._closed:
                raise StoreError("revision_conflict", "任务已停止，拒绝迟到提交")
            if task["requestKind"] not in {"edit", "update_sources"}:
                raise StoreError("invalid_parameter", "普通提问只回答，加入画板需要明确修改请求")
            unit_id = args["unitId"]
            base = task.get("reads", {}).get(unit_id)
            if not base or base["hash"] != args.get("baseHash"):
                raise StoreError("revision_conflict", "请先读取目标的最新正文")
            if self.service.store.snapshot()["generation"] != task["generation"]:
                raise StoreError("revision_conflict", "课程已历史回退，旧任务不能提交")
            current = self.service.content.get(unit_id)
            updated = deepcopy(current["entity"])
            if not isinstance(updated.get("reading"),dict) or not isinstance(updated["reading"].get("blocks"),list):
                raise StoreError("capability_unavailable", "这个单元的正文尚在准备，暂不能修改正文块；仍可依据知识与原文提问")
            original_blocks, latest_blocks = blocks(base["entity"]), blocks(updated)
            edits = args.get("edits")
            if not isinstance(edits, list) or not 1 <= len(edits) <= 100:
                raise StoreError("invalid_content", "需要完整、非空的正文块修改")
            for edit in edits:
                block_id = edit.get("blockId")
                if "newBlock" in edit:
                    block = deepcopy(edit["newBlock"])
                    if block.get("id") != block_id or block_id in latest_blocks or block_id in original_blocks:
                        raise StoreError("revision_conflict", "新增正文块身份已存在")
                    if block.get("kind") not in {"paragraph", "formula", "callout", "interactive"}:
                        raise StoreError("capability_unavailable", "此新增正文块类型尚未支持")
                    updated["reading"]["blocks"].append(block)
                else:
                    original, latest = original_blocks.get(block_id), latest_blocks.get(block_id)
                    if not original or not latest or original != latest:
                        raise StoreError("revision_conflict", "这段内容已被修改，请保留学生变化后重新处理",
                                         {"objectId": unit_id, "blockId": block_id, "current": latest})
                    payload = edit.get("payload")
                    if not isinstance(payload, dict):
                        raise StoreError("invalid_content", "正文块必须提供完整语义 payload")
                    latest["payload"] = deepcopy(payload)
                    if "sourceRefs" in edit:
                        if not isinstance(edit["sourceRefs"], list):
                            raise StoreError("invalid_content", "来源引用必须是数组")
                        latest["sourceRefs"] = deepcopy(edit["sourceRefs"])
            updated["reading"]["revision"] = current["entity"]["reading"]["revision"] + 1
            command = {"operationId": operation_id, "actor": "agent", "kind": "knowledge.edit",
                       "taskId": task["taskId"], "executorTurnId": task["executor"].get("turnId"),
                       "materialChange": args.get("materialChange", False),
                       "materialReason": args.get("materialReason", ""),
                       "generation": task["generation"], "changes": [
                           {"namespace": "knowledge", "key": unit_id, "value": updated}],
                       "expectedRevisions": {f"knowledge:{unit_id}": current["revision"]},
                       "expectedHashes": {f"knowledge:{unit_id}": current["hash"]}}
            result = self.service.apply_command(command)
            if operation_id not in task["operationIds"]:
                task["operationIds"].append(operation_id)
            task["lastSummary"] = args.get("summary", "正文已修改")
            changed_blocks = {edit["blockId"] for edit in edits}
            task["unresolvedConflicts"] = [c for c in task.get("unresolvedConflicts", [])
                if c.get("details", {}).get("objectId") != unit_id or c.get("details", {}).get("blockId") not in changed_blocks]
            if not task["unresolvedConflicts"]:
                task.pop("lastConflict", None)
            self._save_task(task)
            return result

    def _current_request(self, task, request, executor):
        params, mapping = request.get("params", {}), task["executor"]
        return (not self._closed and task["status"] in {"running", "needs_input"}
                and executor is not None and self._executors.get(task["taskId"]) is executor
                and bool(mapping.get("threadId")) and bool(mapping.get("turnId"))
                and params.get("threadId") == mapping["threadId"] == executor.thread_id
                and params.get("turnId") == mapping["turnId"] == executor.turn_id)

    def _permission(self, task, event, executor):
        # Only actual app-server requests produce a permission/input UI, never invented gates.
        with self._lock:
            if not self._current_request(task, event, executor):
                return
            task["status"] = "needs_input"
            task["pendingRequest"] = {"id": event["id"], "method": event["method"],
                                      "params": deepcopy(event.get("params", {}))}
            self._save_task(task)

    def control(self, identifier, action, data=None):
        if not isinstance(identifier,str) or not isinstance(action,str):
            raise StoreError("invalid_parameter", "任务身份或控制方式无效")
        with self._lock:
            task = self._task_cache.get(identifier)
            if task is None:
                raise StoreError("not_found", "找不到 Agent 任务")
            if action == "stop":
                if task["status"] not in ACTIVE:
                    return deepcopy(task)
                task["status"] = "interrupted"
                task["stoppedAt"] = now()
                if task.get("pendingRequest"):
                    task["recoveryNote"] = self._retire_pending_request(
                        task, "任务已停止，已保存结果保留；需要补做时点击继续。")
                self._save_task(task)  # Submission eligibility is revoked before interrupt RPC.
                executor = self._executors.get(identifier)
                if executor:
                    self._spawn(self._interrupt, executor)
            elif action == "continue":
                if identifier in self._executors:
                    raise StoreError("invalid_parameter", "执行器仍在核对，请先停止或等待")
                if task["status"] not in {"interrupted", "failed", "needs_input"}:
                    raise StoreError("invalid_parameter", "此任务尚不能继续")
                if "model" in (data or {}) and data["model"] is not None and not isinstance(data["model"],str):
                    raise StoreError("invalid_parameter", "模型身份无效")
                task["generation"] = self.service.store.snapshot()["generation"]
                task["status"] = "queued"
                task["queueOrder"] = self.service.store.snapshot()["sequence"]
                task["resumeNote"] = (data or {}).get("instruction", "依据最新内容，只补尚未完成的原请求。")
                if "model" in (data or {}):
                    task["model"] = data["model"]
                task["unresolvedConflicts"] = []
                task.pop("lastConflict", None)
                task.pop("pendingRequest", None)
                task.pop("error", None)
                self._save_task(task)
                self._spawn(self._run, identifier)
            elif action == "resolve":
                request = task.get("pendingRequest")
                executor = self._executors.get(identifier)
                if task["status"] != "needs_input" or not request or not self._current_request(task, request, executor):
                    raise StoreError("invalid_parameter", "该请求已不在当前执行器中，请继续任务")
                response = (data or {}).get("response")
                if not isinstance(response, dict):
                    raise StoreError("invalid_parameter", "请输入执行器要求的答复")
                executor.reply_request(request["id"], response)
                task.pop("pendingRequest", None)
                task["status"] = "running"
                self._save_task(task)
            else:
                raise StoreError("invalid_parameter", "未知任务控制操作")
            return deepcopy(task)

    @staticmethod
    def _interrupt(executor):
        try:
            executor.interrupt()
        except StoreError:
            pass

    def notify_change(self, result):
        if result.get("actor") == "agent":
            return
        changed = {c["key"] for c in result.get("changes", []) if c["namespace"] == "knowledge"}
        if not changed:
            return
        with self._lock:
            for task in self._task_cache.values():
                if task["status"] not in {"running", "needs_input"}:
                    continue
                targets = set(task.get("reads", {})) | {task["target"]["objectId"]}
                for unit_id in changed & targets:
                    notice = {"objectId": unit_id, "operationId": result["operationId"], "accepted": False,
                              "notifiedAt": now()}
                    task["concurrentEdits"].append(notice)
                    self._save_task(task)
                    self._spawn(self._steer, task["taskId"], notice)

    def _steer(self, identifier, notice):
        task = self._task_cache[identifier]
        executor = self._executors.get(identifier)
        if executor:
            try:
                record = self.service.content.get(notice["objectId"])
                executor.steer("学生刚在执行期间修改了目标。请保留其最新内容，重新读取后整合。最终必须说明同时修改位置及处理。\n" +
                               json.dumps(record, ensure_ascii=False))
                notice["accepted"] = True
            except (StoreError, KeyError) as exc:
                notice["error"] = str(exc)
            with self._lock:
                self._save_task(task)

    def _mastery_prompt(self, unit_id, operation_id, reason):
        with self._lock:
            prompt_id = "PROMPT-" + digest([unit_id, operation_id])
            if self.service.store.read("reviewPrompts", prompt_id)["value"] is not None:
                return
            state = self.service.store.read("review", unit_id)
            if (state["value"] or {}).get("status") != "mastered":
                return
            self._put("reviewPrompts", prompt_id, {"promptId": prompt_id, "unitId": unit_id,
                      "operationId": operation_id, "reason": reason, "reviewRevision": state["revision"],
                      "resolved": False, "createdAt": now()})

    def resolve_mastery(self, identifier, status):
        if not isinstance(identifier,str):
            raise StoreError("invalid_parameter", "状态询问身份无效")
        with self._lock:
            prompt = self.service.store.read("reviewPrompts", identifier)["value"]
            if not prompt or prompt.get("resolved"):
                raise StoreError("not_found", "状态询问已经处理")
            if not isinstance(status,str) or status not in {"keep", "todo", "weak"}:
                raise StoreError("invalid_parameter", "未知状态选择")
            if status != "keep":
                generation = self.service.store.snapshot()["generation"]
                self.service.apply_command({"operationId": "OP-" + str(uuid.uuid4()), "actor": "student",
                    "kind": "review.confirm", "generation": generation,
                    "expectedRevisions": {f"review:{prompt['unitId']}": prompt["reviewRevision"]},
                    "changes": [{"namespace": "review", "key": prompt["unitId"], "value": {"status": status}}]})
            prompt["resolved"] = True
            self._put("reviewPrompts", identifier, prompt)
            return prompt

    def invalidate_generation(self):
        with self._lock:
            for task in self._task_cache.values():
                if task["status"] in ACTIVE:
                    task["status"] = "interrupted"
                    task["recoveryNote"] = self._retire_pending_request(
                        task, "课程已回退，旧提交资格失效；核对当前内容后可点击继续。")
                    self._save_task(task)
                    executor = self._executors.get(task["taskId"])
                    if executor:
                        self._spawn(self._interrupt, executor)

    def _reconcile_pending(self):
        for task in list(self._task_cache.values()):
            if task["status"] == "reconciling":
                self._reconcile_one(task)

    def _reconcile_one(self, task):
        executor = None
        try:
            with self._lock:
                if self._closed or task["status"] != "reconciling":
                    return
                if task.get("pendingRequest"):
                    task["recoveryNote"] = self._retire_pending_request(task, "正在核对执行器与已保存结果。")
                    self._save_task(task)
            self._recover_commits(task)
            mapping = task.get("executor", {})
            turn = None
            if mapping.get("threadId"):
                executor = self.factory(self.service.root, task.get("model"))
                executor.connect()
                actual = executor.reconcile(mapping)
                turns = actual.get("thread", {}).get("turns", [])
                turn = next((t for t in turns if t.get("id") == mapping.get("turnId")), None)
                task["reconciledExecutorStatus"] = turn.get("status") if turn else "not_found"
            else:
                task["reconciledExecutorStatus"] = "not_started"
            with self._lock:
                if task["status"] == "reconciling":
                    if turn and turn.get("status") == "completed" and not task.get("unresolvedConflicts"):
                        items = [item for item in turn.get("items", []) if item.get("type") == "agentMessage"]
                        final = [item for item in items if item.get("phase") in {"final_answer", "finalAnswer"}]
                        text = "\n\n".join(item.get("text", "") for item in (final or items))
                        if text:
                            self._message(task, text)
                        task["status"] = "completed"
                        task["recoveryNote"] = self._retire_pending_request(
                            task, "已从执行器恢复完整结果，并核对本地提交；没有重跑。")
                        task.pop("error", None)
                    else:
                        task["status"] = "needs_input"
                        task["recoveryNote"] = self._retire_pending_request(
                            task, "已核对执行器与本地提交记录。已保存结果保留；需要补做时点击继续。")
                    self._save_task(task)
        except Exception as exc:
            with self._lock:
                if task["status"] == "reconciling":
                    task["status"] = "needs_input"
                    task["recoveryNote"] = self._retire_pending_request(
                        task, "无法确认执行器最终状态，未重跑。课程已保存内容可用，点击继续前请核对。")
                    task["reconcileError"] = str(exc)
                    self._save_task(task)
        finally:
            if executor:
                executor.close()

    def close(self):
        self._closed = True
        for executor in list(self._executors.values()):
            self._interrupt(executor)
            executor.close()
        for worker in self._workers:
            if worker is not threading.current_thread():
                worker.join(timeout=1)
