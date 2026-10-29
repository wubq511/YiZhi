import { createRoot } from 'react-dom/client';
import { Workspace } from '../../desktop/src/renderer/workspace';
import { ControlledProducer } from './controlled-producer';
createRoot(document.getElementById('root')!).render(<Workspace Accessory={ControlledProducer} />);
