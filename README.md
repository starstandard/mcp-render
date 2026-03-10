# Appointment Metadata MCP Server

A Render-ready MCP server that exposes your Appointment OpenAPI spec as AI-friendly metadata tools.

## What changed in this upgraded build

This version adds stronger API-intelligence capabilities so technical and business users can do more than just browse the spec.

New capabilities:
- operation explorer with grouping filters
- write-operation finder
- schema dependency mapper
- sub-API recommender
- reduced OpenAPI generator for common API cuts
- friendly root route at `/`

## Included MCP tools

- `getApiOverview`
- `listOperations`
- `listWriteOperations`
- `getOperationDetails`
- `explainOperationForBusiness`
- `listSchemas`
- `getSchema`
- `getSchemaDependencies`
- `suggestSubApis`
- `generateSubApiSpec`
- `generateConsumerSummary`
- `getRawSpec` (optional; enabled only if `ALLOW_RAW_SPEC=true`)

## Local development

```bash
cp .env.example .env
npm install
npm run dev
```

Then test:

```bash
curl http://localhost:4000/
curl http://localhost:4000/health
```

## Build for production

```bash
npm run build
npm start
```

## Deploy to Render as a Web Service

1. Push this project to GitHub.
2. In Render, choose **New +** -> **Web Service**.
3. Select the repo.
4. Use:
   - Build Command: `npm install && npm run build`
   - Start Command: `npm start`
5. Add env vars from `.env.example` if Render does not import them automatically.

## Recommended Render settings

- Runtime: Node
- Node version: 22
- Health check path: `/health`
- Plan: Starter for always-on behavior, or Free for testing only

## MCP endpoint

After deployment, your MCP endpoint will be:

```text
https://<your-service>.onrender.com/mcp
```

## Example things an AI client can ask

- List all Appointment write operations.
- Explain `createAppointmentEntity` for a business analyst.
- Show schema dependencies for `AppointmentCreate`.
- Suggest smaller sub-APIs from this monolith spec.
- Generate a reduced YAML for the workflow sub-API.
