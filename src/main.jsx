import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { installStaleChunkReload } from './utils/staleChunk.js'

// A tab open across a deploy points at the previous build's chunk files.
// Reload instead of throwing "Failed to fetch dynamically imported module".
installStaleChunkReload()

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
