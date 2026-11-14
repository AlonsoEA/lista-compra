# Lista de la compra

Web app para llevar listas de la compra compartidas (con la familia, con amigos…) desde el iPhone.

## Qué hace

- **Lista compartida**: cualquiera apunta lo que hace falta y los demás lo ven al momento.
- **Compra**: eliges el súper (Carrefour, Lidl, Cash, Día, Mercadona u otro), vas metiendo productos en el carro con su precio y su cantidad, y la app suma el total. También puedes añadir productos que no estaban en la lista.
- **Precios recordados**: la app recuerda el último precio de cada producto en cada súper.
- **Ticket**: al terminar se guarda qué se compró, cuánto de cada cosa, a qué precio y el total. Se puede corregir después.
- **Calendario**: los días de compra aparecen destacados, con el gasto del mes. Toca un día para ver su ticket.

## Cuenta y listas

Cada persona entra con **su cuenta** (correo y contraseña). La primera vez pulsa *Crear cuenta*; después la sesión se queda abierta en ese dispositivo. Las listas van con la cuenta: al iniciar sesión en otro móvil aparecen solas.

Dentro de la app:

- **Crear una lista nueva**: le pones nombre (Casa, Amigos…) y la app le asigna un **código**.
- **Unirme a una lista con un código**: escribes el código que te han pasado.

Puedes estar en **varias listas** a la vez. Toca el nombre de la lista, arriba en la pestaña *Lista*, para cambiar de una a otra, crear otra o unirte a otra. Cada lista tiene sus propios productos, tickets, supermercados y código.

## Instalar en el iPhone

1. Abre la dirección de la app en **Safari**.
2. Toca **Compartir** (el cuadrado con la flecha) → **Añadir a pantalla de inicio**.
3. Ábrela siempre desde el icono.

## Publicar con GitHub Pages

En el repositorio: *Settings → Pages*. En *Source* elige *Deploy from a branch*, la rama `main` y la carpeta `/ (root)`.

## Firebase

1. En la consola de Firebase, activa **Authentication → Correo electrónico/contraseña** y crea la base de datos **Firestore**.
2. Pega la configuración web del proyecto en `firebase-config.js`.
3. Copia el contenido de `firestore.rules` en *Firestore Database → Reglas* y pulsa **Publicar**.

Mientras `firebase-config.js` esté en `null`, la app funciona solo en el dispositivo, sin compartir (para pruebas).

## Actualizar la app

Después de cambiar algo, sube a la vez el número de `CACHE` en `sw.js` (por ejemplo `compra-v5`) y `APP_VERSION` en `app.js` (`v5`). Así el iPhone descarga la versión nueva, y la versión se ve al final de *Ajustes* para comprobar que coincide con la del manual.
