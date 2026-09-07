import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles/global.css'
import { useStore } from './store/app'

// Exposed for automated UI tests (renderer-local state only).
;(window as unknown as { __yonderStore: typeof useStore }).__yonderStore = useStore

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
