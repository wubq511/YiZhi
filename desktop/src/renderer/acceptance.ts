import { observation } from '../acceptance-observation';
// Only aggregate counters are exposed; the harness separately samples DOM/runtime memory.
if ((window as any).yizhiObservationEnabled === true) {
  observation.enable();
  (window as any).__yizhiObservation = () => observation.snapshot();
}
