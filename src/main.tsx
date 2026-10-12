import App from './App';
import './styles.css';

// NOTE: no React.StrictMode on purpose — toy engines own WebGL contexts and
// rAF loops, and StrictMode's effect double-invoke would lose/recreate GPU
// contexts pointlessly in dev.
import { createRoot } from 'react-dom/client';

createRoot(document.getElementById('root')!).render(<App />);
