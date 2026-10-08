# Ecom Dash Backend

NestJS 11 backend using TypeScript in strict mode and the Express adapter.

## Development

Use Node.js 24 LTS and npm. From this folder:

```powershell
npm ci
npm run start:dev
```

The API runs at `http://localhost:3001`. `GET /` returns `Hello World!`.
The dashboard can run alongside it on port 3000.

To change the backend port in PowerShell:

```powershell
$env:PORT = '4000'
npm run start:dev
```

## Commands

- `npm run build` — compile to `dist/`.
- `npm run start:prod` — start the compiled application after building.
- `npm run lint` — lint and fix TypeScript files.
- `npm run format` — format source and test files.
- `npm test` — run unit tests.
- `npm run test:e2e` — run HTTP integration tests.

## Structure

- `src/main.ts` — application startup, port, and shutdown hooks.
- `src/app.module.ts` — root application module.
- `src/app.controller.ts` — starter HTTP endpoint.
- `src/app.service.ts` — starter service.
- `test/` — HTTP integration tests.

Generate additional modules using the local CLI:

```powershell
npx nest generate module orders
npx nest generate controller orders
npx nest generate service orders
```
