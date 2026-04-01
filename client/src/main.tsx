import React from 'react'
import ReactDOM from 'react-dom/client'
import './index.css'
import App from './App'
import { debugMusicKit } from './services/musickit'
;(window as any).debugMusicKit = debugMusicKit

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
