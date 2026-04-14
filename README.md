# Sync Viajes — Transportes Bello

Herramienta para sincronizar el CSV de tramos/viajes exportado del sistema de transporte hacia el Google Sheet de detalle de viajes.

## Flujo
1. Subir CSV exportado del sistema (separador `;`, 13 columnas)
2. Preview con estadísticas: total filas, expediciones, clientes, tramos con solicitud
3. Elegir fecha de corte: automático (hoy - 14 días), desde inicio del CSV, o manual
4. Confirmar y sincronizar → borra del Sheet desde la fecha de corte y escribe los nuevos datos

## Setup

### 1. Instalar dependencias
```bash
npm install
```

### 2. Configurar OAuth Client ID
En `src/App.jsx`, agrega tu Google OAuth Client ID:
```js
const CLIENT_ID = "tu-client-id.apps.googleusercontent.com";
```

Puedes reutilizar el mismo Client ID de sync-ventas. Solo necesitas agregar el nuevo dominio de Vercel como origen autorizado en Google Cloud Console → APIs & Services → Credentials.

### 3. Desarrollo local
```bash
npm run dev
```

### 4. Deploy a Vercel
```bash
# Conectar repo de GitHub y deploy automático
# O manual:
npx vercel
```

## Config ya hardcodeada
- **Sheet ID:** `1PWoAECjRVGu85YH3r8zL0s-Wi2CastXMYDWGtd7S8ZI`
- **Hoja:** `detalle viajes`
- **CSV público:** Configurado como referencia

## Estructura del CSV
| Columna | Ejemplo |
|---------|---------|
| Expedicion | 72097 |
| Solicitud | 238378 |
| Cliente | MAXAM CHILE S.A |
| Nombre | CLAUDIO ANTONIO |
| Apellido | PALMA TOLEDO |
| Fecha | 01/04/2026 |
| Tracto | TBTP71 |
| Rampla | HXFX45 |
| Origen | MINERA ESCONDIDA |
| Destino | MINERA ESCONDIDA |
| Kilometro | 26 |
| Carga | NITRATO DE AMONIO |
| Guia | 701222 |
