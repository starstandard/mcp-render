# Appointment Metadata MCP Server

A Render-ready MCP server that exposes your Appointment OpenAPI spec as AI-friendly metadata tools.

## What this server is for

This server is **not** for executing live appointment transactions against a backend. It is for helping AI clients and users:

- explore endpoints and operations
- understand schemas
- explain the API in business language
- suggest smaller sub-APIs
- inspect commands, exports, and event-message capabilities

## Included MCP tools

- `getApiOverview`
- `listOperations`
- `getOperationDetails`
- `explainOperationForBusiness`
- `listSchemas`
- `getSchema`
- `suggestSubApis`
- `generateConsumerSummary`
- `getRawSpec` (optional; enabled only if `ALLOW_WRITE_TOOLS=true`)

## Local development

```bash
cp .env.example .env
npm install
npm run dev
```

Then test:

```bash
curl http://localhost:4000/health
```

## Build for production

```bash
npm run build
npm start
```

## Deploy to Render

### Option 1: Blueprint

This repo includes a `render.yaml` file.

1. Push this project to GitHub.
2. In Render, choose **New +** -> **Blueprint**.
3. Select the repo.
4. Deploy.

### Option 2: Web Service

1. Push this project to GitHub.
2. In Render, choose **New +** -> **Web Service**.
3. Select the repo.
4. Use:
   - Build Command: `npm install && npm run build`
   - Start Command: `npm start`
5. Add env vars from `.env.example`.

## Recommended Render settings

- Runtime: Node
- Node version: 22
- Health check path: `/health`
- Plan: Starter for a small always-on demo, or Free/Hobby-style testing only if available and acceptable for spin-down behavior

## MCP endpoint

After deployment, your MCP endpoint will be:

```text
https://<your-service>.onrender.com/mcp
```

## Notes

- The OpenAPI file is bundled in `openapi/appointment-api.yaml`.
- If you update the spec, redeploy the service.
- This server is metadata-first and safer than exposing live write tools before you are ready.
