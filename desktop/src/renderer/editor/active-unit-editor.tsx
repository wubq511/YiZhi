import { useEffect, useMemo, useRef, useState, type ComponentProps } from 'react';
import type { OpenedCourse } from '../../shared';
import { ParagraphSaveChannel, type SaveState } from '../save-channel';
import { ContinuousUnitEditor } from './continuous-editor';
import type { ContinuousEditor } from './controller';

export interface UnitInputHandle {
  ready(): Promise<ContinuousEditor>;
  flush(endEditing?: boolean): Promise<boolean>;
  synchronize(): Promise<void>;
  editor(): ContinuousEditor | null;
}
type Props = Omit<ComponentProps<typeof ContinuousUnitEditor>, 'course' | 'channel' | 'saveError' | 'controller'> & {
  sessionId: string; unitId: string;
  register(unitId: string, handle: UnitInputHandle | null): void;
  updated(snapshot: OpenedCourse): void;
};
/** One instance for the actively read B. Navigation/close drain it before unmounting. */
export function ActiveUnitEditor(props: Props) {
  const [course, setCourse] = useState<OpenedCourse>(), [state, setState] = useState<SaveState>({ status: 'saved' });
  const editor = useRef<ContinuousEditor | null>(null), channel = useRef<ParagraphSaveChannel | undefined>(undefined);
  const readiness = useMemo(() => {
    let resolve!: (editor: ContinuousEditor) => void, reject!: (error: Error) => void;
    const promise = new Promise<ContinuousEditor>((yes, no) => { resolve = yes; reject = no; });
    void promise.catch(() => {});
    return { promise, resolve, reject };
  }, [props.sessionId, props.unitId]);
  const latest = useRef(props); latest.current = props;
  useEffect(() => {
    let disposed = false;
    const ready = window.yizhi.read(props.sessionId, props.unitId).then(snapshot => {
      if (disposed) return;
      channel.current = new ParagraphSaveChannel(window.yizhi, snapshot, setState, { onSnapshot: next => {
        if (!disposed) { setCourse(next); latest.current.updated(next); }
      } });
      setCourse(snapshot);
    }).catch(error => { readiness.reject(error); if (!disposed) setState({ status: 'error', error: error.message }); });
    latest.current.register(props.unitId, {
      ready: () => readiness.promise,
      async flush(endEditing = false) { await ready; if (!channel.current || !await channel.current.flush()) return false; return !endEditing || !editor.current || await editor.current.finish(); },
      async synchronize() { await ready; await channel.current?.synchronize(); },
      editor: () => editor.current,
    });
    return () => { disposed = true; readiness.reject(new Error('当前单元编辑器已离开')); channel.current?.dispose(); latest.current.register(props.unitId, null); };
  }, [props.sessionId, props.unitId, readiness]);
  if (!course || !channel.current) return <p role="status">{state.error ?? '正在读取当前正文与输入…'}</p>;
  return <>
    <ContinuousUnitEditor {...props} course={course} channel={channel.current} saveError={state.status === 'error'} controller={value => { editor.current = value; if (value) readiness.resolve(value); }} />
    <p role="status" aria-label="当前单元保存状态">{({ saved: '已保存', draft: '草稿已保留', pending: '待保存', saving: '正在保存…', error: '未保存' })[state.status]}</p>
    {state.error && <div role="alert" className="save-error">{state.error}<button onClick={() => void channel.current?.flush()}>重试当前单元保存</button></div>}
  </>;
}
