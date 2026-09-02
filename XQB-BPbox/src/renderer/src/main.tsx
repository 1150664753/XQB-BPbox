import './styles/vscode-light.css'
import './styles/light-workbench.css'
import './styles/display-settings.css'
import './styles/remote-bp.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
