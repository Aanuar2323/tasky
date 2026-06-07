# 🛡️ Documentación de Ciberseguridad (Backend)

Este documento detalla las medidas de seguridad, prevenciones y mitigaciones implementadas en el backend (API) de la aplicación **Tasky**. La API está diseñada asumiendo un entorno en el que los recursos pueden ser abusados, por lo que se emplean varias capas de defensa activa.

---

## 1. Cabeceras de Seguridad (HTTP Headers)
**Implementación:** Uso del middleware `helmet` en `index.js`.
**¿Cómo funciona?**
Al habilitar Helmet, Express envía automáticamente un conjunto de cabeceras HTTP que protegen al cliente (navegadores) y al servidor:
* **X-XSS-Protection:** Previene inyecciones de código malicioso (Cross-Site Scripting).
* **X-Frame-Options:** Establecido en `SAMEORIGIN` o `DENY`, lo que impide que un atacante incruste el sitio en un `<iframe>` oculto para robar clics (ataques de *Clickjacking*).
* **Strict-Transport-Security (HSTS):** Fuerza al navegador a usar siempre conexiones seguras HTTPS (si el sitio está tras un proxy SSL).
* **Ocultar X-Powered-By:** Se elimina la cabecera que delata que estamos usando Express/Node.js, mitigando ataques automatizados dirigidos a este framework.

## 2. Política de Origen (CORS Restringido)
**Implementación:** Configuración dinámica de `cors` en `index.js`.
**¿Cómo funciona?**
Cross-Origin Resource Sharing (CORS) dicta qué dominios externos pueden pedir datos a la API mediante AJAX/Fetch.
* En **Desarrollo**, la regla permite tráfico general (`*`) para no obstaculizar herramientas locales.
* En **Producción** (cuando `NODE_ENV === 'production'`), el CORS se ancla rígidamente al dominio del Frontend (ej. `https://midominio.com`).
* **Protección lograda:** Evita que scripts piratas alojados en otros sitios web puedan leer la base de datos o suplantar a usuarios activos enviando peticiones no autorizadas al backend de Tasky.

## 3. Rate Limiting (Prevención de DoS y Fraude)
**Implementación:** Uso de `express-rate-limit` con dos escudos separados.
**¿Cómo funciona?**
Lleva un conteo en memoria de cuántas veces una dirección IP realiza peticiones al servidor en una ventana de tiempo, devolviendo el código HTTP `429 Too Many Requests` si se excede:
1. **Escudo Global (`limiter`)**: Limita a cada IP a **200 peticiones cada 15 minutos**. Protege el acceso general al disco (lectura/escritura de tareas), previniendo ataques de Denegación de Servicio (DoS).
2. **Escudo de Inteligencia Artificial (`aiLimiter`)**: Aplicado específicamente a la ruta `POST /api/projects/:id/chat`. Limita a **50 peticiones por hora**.
* **Protección Lograda:** Previene fraudes económicos (Agotamiento de Billetera/Cost Exhaustion). Evita que un script malicioso consuma el saldo de la API Key de OpenRouter en cuestión de segundos.

## 4. Inyección de Rutas (Path Traversal - CWE-22)
**Implementación:** Función utilitaria `safeJoin` en `storage.js`.
**¿Cómo funciona?**
Dado que la aplicación lee y guarda archivos usando rutas pasadas desde el frontend, existe el riesgo de que un atacante envíe una ruta maliciosa como `?path=../../../../etc/passwd` para leer datos del sistema operativo.
* `safeJoin` utiliza `path.resolve` de Node para fusionar el directorio base del proyecto con la ruta relativa del usuario.
* **Verificación estricta:** Comprueba matemáticamente que el *string* resultante siga comenzando con el directorio base del proyecto (`normalizedRoot`). Si la ruta "escapa" del proyecto, arroja un error (`Invalid path`) y detiene la ejecución inmediatamente.

## 5. Prevención en Archivos Binarios (Multer)
**Implementación:** `multer.memoryStorage()` con límites de tamaño (`index.js`).
**¿Cómo funciona?**
* **Tope de Memoria (`limits: { fileSize: 50MB }`)**: Evita que atacantes suban archivos gigantes (e.g., 10 GB) que podrían agotar la memoria RAM del servidor (Out Of Memory Error).
* Los archivos se procesan en la memoria de Node antes de ser pasados al disco duro, previniendo inyección de malware en el file-system del servidor si la app no decide escribirlos explícitamente.

---

## 🔒 Pendientes para el Entorno de Producción Final

Si la aplicación va a salir al internet público, deben aplicarse estas medidas en el entorno de despliegue:

1. **HTTPS Cifrado de Extremo a Extremo:** Configurar un Reverse Proxy (como NGINX o un equilibrador de carga en AWS/Vercel) para cifrar todo el tráfico con certificados TLS (Let's Encrypt). Express no debe exponerse sin un proxy delante.
2. **Autenticación (API Keys o JWT):** Actualmente el sistema MVP asume un usuario `default`. Antes de publicarlo, la API debe implementar un Middleware (como la plantilla `requireAuth` presente en el código) para rechazar peticiones que no tengan un *Bearer Token* o sesión válida validando la cabecera `Authorization`.
3. **Filtro de Extensiones en Multer:** Añadir una validación `fileFilter` a `multer` para bloquear extensiones de script ejecutables (`.exe`, `.sh`, `.bat`) de origen.
