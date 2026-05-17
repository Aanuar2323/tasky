/**
 * main.tsx — Punto de entrada de la aplicación React
 *
 * Este archivo monta el componente raíz (App) en el DOM.
 * Es el primer código JavaScript que se ejecuta en el navegador.
 *
 * Flujo:
 *  1. Importa los estilos globales (index.css con Tailwind)
 *  2. Importa el componente principal App
 *  3. Busca el elemento #root del HTML
 *  4. Renderiza App dentro de StrictMode (React verifica buenas prácticas en desarrollo)
 */

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

/* Estilos globales: reset, Tailwind CSS y estilos base de la aplicación */
import './index.css'
import './App.css'

/* Componente raíz de la aplicación */
import App from './App.tsx'

/* Montar la aplicación React en el elemento #root del HTML */
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
