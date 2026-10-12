import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

// NOTE: no React.StrictMode — the cymatics engine owns a WebGL2 context,
// ping-pong FBOs and an AudioContext; StrictMode's effect double-invoke
// tears down and rebuilds those pointlessly in dev.
createRoot(document.getElementById('root')!).render(<App />);
