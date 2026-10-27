import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import './style.css';
import type { DesktopBridge, OpenedCourse, ReadingBlock } from '../shared';
import { ParagraphSaveChannel, type SaveState } from './save-channel';
import { ControlledProducer } from './controlled-producer';
declare global { interface Window { yizhi: DesktopBridge } }

function Block({ block }: { block: ReadingBlock }) {
  const payload = block.payload;
  const children = block.children?.map(child => <Block key={child.id} block={child} />);
  if (block.kind === 'paragraph') return <p>{payload.text}</p>;
  if (block.kind === 'formula') return <div className="formula" role="math" aria-label={payload.latex}
    dangerouslySetInnerHTML={{ __html: katex.renderToString(payload.latex, { throwOnError: false, trust: false, displayMode: true }) }} />;
  if (block.kind === 'table') return <div className="table-scroll" tabIndex={0} aria-label="数制对照表"><table>
    <thead><tr>{payload.columns.map((column: string, i: number) => <th key={i}>{column}</th>)}</tr></thead>
    <tbody>{payload.rows.map((row: (string | number)[], i: number) => <tr key={i}>{row.map((cell, j) => <td key={j}>{cell}</td>)}</tr>)}</tbody>
  </table></div>;
  if (block.kind === 'callout') return <aside className="reminder"><p>{payload.text}</p>{children}</aside>;
  if (block.kind === 'steps') return <ol>{payload.items.map((item: string, i: number) => <li key={i}>{item}</li>)}{children}</ol>;
  if (block.kind === 'example' || block.kind === 'exercise') return <details className="material" open={block.kind === 'example'}>
    <summary>{payload.title}</summary><p>{payload.problem}</p>
    {payload.hint && <details className="hint"><summary>学习提示</summary><p>{payload.hint}</p></details>}
    {block.kind === 'exercise' ? <details className="answer"><summary>答案与步骤</summary>{children}</details> : children}
  </details>;
  if (block.kind === 'knowledge-reference') return <p className="reference">{payload.intent}<small>所引单元尚未导入此课程副本</small></p>;
  return <details><summary>保留的内容 · {block.kind}</summary><pre>{JSON.stringify(payload, null, 2)}</pre>{children}</details>;
}

function App() {
  const [course, setCourse] = useState<OpenedCourse>();
  const [loadError, setLoadError] = useState<string>();
  const [state, setState] = useState<SaveState>({ status: 'saved' });
  const [closing, setClosing] = useState(false);
  const [producerBusy, setProducerBusy] = useState(false);
  const producerRunning = useRef(false);
  const channel = useRef<ParagraphSaveChannel | undefined>(undefined);
  const editor = useRef<HTMLDivElement>(null);
  const secondEditor = useRef<HTMLDivElement>(null);
  const secondId = useRef<string | undefined>(undefined);
  const composing = useRef(false);
  const load = async () => {
    setLoadError(undefined);
    try {
      const opened = await window.yizhi.open();
      channel.current?.dispose();
      secondId.current = opened.unit.reading.blocks.filter(b => b.kind === 'paragraph')[1]?.id;
      channel.current = new ParagraphSaveChannel(window.yizhi, opened, setState, { onSnapshot: setCourse });
      setCourse(opened);
    } catch (error) { setLoadError((error as Error).message); }
  };
  useEffect(() => { void load(); return () => channel.current?.dispose(); }, []);
  useEffect(() => window.yizhi.onCloseRequested(async () => {
    if (producerRunning.current) return false;
    if (composing.current) {
      setState({ status: 'error', error: '请先完成中文候选输入，再关闭窗口。' });
      return false;
    }
    // A failed course open owns no editable input and must still allow normal exit.
    if (!channel.current) return true;
    setClosing(true);
    const saved = await channel.current.flush();
    if (!saved) setClosing(false);
    return saved;
  }), []);
  useEffect(() => {
    if (course && editor.current && document.activeElement !== editor.current) editor.current.textContent = channel.current?.text(course.editableBlockId)
      ?? String(course.unit.reading.blocks.find(block => block.id === course.editableBlockId)?.payload.text ?? '');
    const second = course?.unit.reading.blocks.find(b => b.id === secondId.current);
    if (second && secondEditor.current && document.activeElement !== secondEditor.current) secondEditor.current.textContent = channel.current?.text(second.id) ?? String(second.payload.text);
  }, [course]);
  const splitFirst = async () => {
    if (!channel.current || !course || composing.current) return;
    if (!await channel.current.flush()) return;
    const length = Array.from(editor.current?.innerText ?? '').length;
    if (length < 2) return;
    channel.current.edit({ changes: [], splits: [{ blockId: course.editableBlockId,
      newBlockId: crypto.randomUUID(), offset: Math.floor(length / 2) }] });
    if (await channel.current.flush()) setCourse(await window.yizhi.read(course.sessionId));
  };
  const status = { draft: '草稿已保留', saved: '已保存', pending: '待保存', saving: '正在保存…', error: '未保存' }[state.status];
  return <>
    <header className="app-header"><strong className="brand">绎知</strong><span>数字逻辑 · 期中复习</span>
      {course && <ControlledProducer course={course} prepare={async () => {
        if (composing.current) throw new Error('请先完成中文候选输入，再运行可控修改。');
        producerRunning.current = true; setProducerBusy(true);
        if (!await channel.current?.flush()) throw new Error('学生输入尚未保存，请先重试保存。');
      }} committed={async () => {
        const current = await window.yizhi.open();
        channel.current?.dispose();
        channel.current = new ParagraphSaveChannel(window.yizhi, current, setState, { onSnapshot: setCourse });
        setCourse(current);
      }} settled={() => { producerRunning.current = false; setProducerBusy(false); }} />}
      <div className="save-area"><span role="status" aria-label="保存状态" aria-live="polite" className={state.status}>{course ? status : '正在打开课程…'}</span>
        {state.status === 'error' && <button onClick={() => void channel.current?.flush()}>重试保存</button>}
      </div>
    </header>
    {state.error && <div className="save-error" role="alert">{state.error} 输入仍保留，请重试保存。</div>}
    <div className="workspace">
      <nav aria-label="课程目录"><h2>课程目录</h2><p className="theme">数制与数制转换</p>
        <a href="#unit" aria-current="page">位置记数法与权展开</a>
        <p className="scope">当前课程副本含一个单元</p></nav>
      <main>
        {loadError ? <div className="load-error" role="alert"><h1>课程未打开</h1><p>{loadError}</p><button onClick={() => void load()}>重新打开课程</button></div>
          : !course ? <div className="loading" aria-busy="true">正在读取本地课程正文…</div>
          : <article id="unit">
            <h1>{course.unit.name}</h1>
            <p className="unit-meta">课程重要性 {course.unit.rating.stars} / 5 · {course.unit.id}</p>
            <p className="outcome">{course.unit.outcome}</p>
            <div className="editable-section"><label id="editor-label">首段正文 <span>可直接编辑，自动保存</span></label>
              <div ref={editor} role="textbox" aria-label="编辑首段正文" aria-multiline="true"
                contentEditable={!closing && !producerBusy} suppressContentEditableWarning className="paragraph-editor"
                onInput={event => { if (!composing.current) channel.current?.input(event.currentTarget.innerText); }}
                onCompositionStart={() => { composing.current = true; }}
                onCompositionEnd={event => { composing.current = false; channel.current?.input(event.currentTarget.innerText); }} />
            </div>
            <button disabled={closing || producerBusy} onClick={() => void splitFirst()}>拆分首段为两段</button>
            {course.unit.reading.blocks.slice(1).map(block => block.id === secondId.current
              ? <div key={block.id} className="editable-section"><label>第二段正文 <span>与首段共同自动保存</span></label>
                <div ref={secondEditor} role="textbox" aria-label="编辑第二段正文" aria-multiline="true"
                  contentEditable={!closing && !producerBusy} suppressContentEditableWarning className="paragraph-editor"
                  onInput={event => { if (!composing.current) channel.current?.edit({ changes: [{ blockId: block.id, text: event.currentTarget.innerText }] }); }}
                  onCompositionStart={() => { composing.current = true; }}
                  onCompositionEnd={event => { composing.current = false; channel.current?.edit({ changes: [{ blockId: block.id, text: event.currentTarget.innerText }] }); }} />
                </div>
              : <Block key={block.id} block={block} />)}
            <footer>来源：既有数字逻辑课程单元的独立副本。编辑保留原有知识身份。</footer>
          </article>}
      </main>
    </div>
  </>;
}
createRoot(document.getElementById('root')!).render(<App />);
