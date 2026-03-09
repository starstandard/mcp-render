import 'dotenv/config';
import express, { type Request, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const PORT = Number(process.env.PORT || 4000);
const SERVER_NAME = process.env.SERVER_NAME || 'appointment-metadata-mcp';
const SPEC_FILE = process.env.SPEC_FILE || './openapi/appointment-api.yaml';
const ALLOW_WRITE_TOOLS = String(process.env.ALLOW_WRITE_TOOLS || 'false').toLowerCase() === 'true';

const resolvedSpecPath = path.resolve(process.cwd(), SPEC_FILE);
if (!fs.existsSync(resolvedSpecPath)) {
  throw new Error(`SPEC_FILE not found: ${resolvedSpecPath}`);
}

const rawSpec = fs.readFileSync(resolvedSpecPath, 'utf8');
const spec = yaml.load(rawSpec) as any;
const paths = spec.paths ?? {};
const schemas = spec.components?.schemas ?? {};

function isWriteMethod(method: string): boolean {
  return ['post', 'put', 'patch', 'delete'].includes(method.toLowerCase());
}

function listOperations() {
  return Object.entries(paths).flatMap(([route, methods]) =>
    Object.entries(methods as Record<string, any>).map(([method, op]) => ({
      path: route,
      method: method.toUpperCase(),
      operationId: op.operationId ?? null,
      summary: op.summary ?? '',
      description: op.description ?? '',
      tags: op.tags ?? [],
      is_write: isWriteMethod(method),
      parameters: (op.parameters ?? []).map((p: any) => ({
        name: p.name,
        in: p.in,
        required: !!p.required,
        schema: p.schema ?? null,
        description: p.description ?? ''
      })),
      requestBody: op.requestBody ?? null,
      responses: op.responses ?? {}
    }))
  );
}

const operations = listOperations();

function findOperation(identifier: string) {
  return operations.find(op => op.operationId === identifier || `${op.method} ${op.path}` === identifier);
}

function summarizeForBusiness(op: any): string {
  const action = op.summary || op.operationId || `${op.method} ${op.path}`;
  const params = (op.parameters || []).map((p: any) => `${p.name}${p.required ? ' (required)' : ''}`).join(', ');
  const hasBody = !!op.requestBody;
  const writes = op.is_write ? 'This changes data.' : 'This only reads data.';
  return `${action}. Route: ${op.method} ${op.path}. ${writes} ${params ? `Main inputs: ${params}.` : ''} ${hasBody ? 'It also accepts a JSON request body.' : ''}`.trim();
}

function inferDomainBuckets() {
  const buckets = [
    { name: 'Core Appointment CRUD', match: (op: any) => /^\/appointments(\/\{appointment_key\})?$/.test(op.path) },
    { name: 'Capabilities & metadata', match: (op: any) => op.path.includes('/capabilities') },
    { name: 'Bulk and exports', match: (op: any) => op.path.includes('/batch') || op.path.includes('/exports') },
    { name: 'Commands / workflows', match: (op: any) => op.path.includes('/commands') },
    { name: 'Event messages / audit trail', match: (op: any) => op.path.includes('/event-messages') }
  ];
  return buckets.map(bucket => ({
    name: bucket.name,
    operations: operations.filter(bucket.match).map(op => ({ method: op.method, path: op.path, operationId: op.operationId, summary: op.summary }))
  })).filter(b => b.operations.length > 0);
}

const app = express();
app.use(express.json({ limit: '1mb' }));

const server = new McpServer({ name: SERVER_NAME, version: '1.0.0' });

server.tool(
  'getApiOverview',
  'Return a high-level summary of the Appointment API and its business capabilities.',
  {},
  async () => ({
    content: [{
      type: 'json',
      json: {
        openapi: spec.openapi,
        title: spec.info?.title,
        version: spec.info?.version,
        description: spec.info?.description,
        operation_count: operations.length,
        schema_count: Object.keys(schemas).length,
        domain_buckets: inferDomainBuckets()
      }
    }]
  })
);

server.tool(
  'listOperations',
  'List all operations, optionally filtering by text or by read vs write intent.',
  {
    query: z.string().optional(),
    include_write: z.boolean().optional().default(true),
    include_read: z.boolean().optional().default(true)
  },
  async ({ query, include_write = true, include_read = true }) => {
    const q = query?.toLowerCase().trim();
    const filtered = operations.filter(op => {
      if (op.is_write && !include_write) return false;
      if (!op.is_write && !include_read) return false;
      if (!q) return true;
      const hay = JSON.stringify(op).toLowerCase();
      return hay.includes(q);
    });
    return { content: [{ type: 'json', json: filtered }] };
  }
);

server.tool(
  'getOperationDetails',
  'Get details for one operation by operationId or exact "METHOD /path".',
  { identifier: z.string() },
  async ({ identifier }) => {
    const op = findOperation(identifier);
    if (!op) {
      return { content: [{ type: 'text', text: `Operation not found: ${identifier}` }] };
    }
    return { content: [{ type: 'json', json: op }] };
  }
);

server.tool(
  'explainOperationForBusiness',
  'Explain an operation in plain language for non-technical stakeholders.',
  { identifier: z.string() },
  async ({ identifier }) => {
    const op = findOperation(identifier);
    if (!op) {
      return { content: [{ type: 'text', text: `Operation not found: ${identifier}` }] };
    }
    return { content: [{ type: 'text', text: summarizeForBusiness(op) }] };
  }
);

server.tool(
  'getSchema',
  'Return a schema definition by exact schema name from components.schemas.',
  { schema_name: z.string() },
  async ({ schema_name }) => {
    const schema = schemas[schema_name];
    if (!schema) {
      return { content: [{ type: 'text', text: `Schema not found: ${schema_name}` }] };
    }
    return { content: [{ type: 'json', json: schema }] };
  }
);

server.tool(
  'listSchemas',
  'List schema names, optionally filtered by a text query.',
  { query: z.string().optional() },
  async ({ query }) => {
    const q = query?.toLowerCase().trim();
    const result = Object.entries(schemas)
      .filter(([name, schema]: [string, any]) => !q || name.toLowerCase().includes(q) || JSON.stringify(schema).toLowerCase().includes(q))
      .map(([name, schema]: [string, any]) => ({ name, type: schema.type ?? null, description: schema.description ?? '' }));
    return { content: [{ type: 'json', json: result }] };
  }
);

server.tool(
  'suggestSubApis',
  'Suggest smaller sub-APIs based on the Appointment spec structure.',
  {},
  async () => {
    const suggestions = [
      {
        name: 'Appointment Core API',
        rationale: 'Best for consumer applications that create, read, update, and cancel appointments.',
        include: operations.filter(op => /^\/appointments(\/\{appointment_key\})?$/.test(op.path)).map(op => `${op.method} ${op.path}`)
      },
      {
        name: 'Appointment Workflow API',
        rationale: 'Best for orchestration and state transitions such as cancel, confirm, and reschedule.',
        include: operations.filter(op => op.path.includes('/commands') || op.path.includes('/capabilities')).map(op => `${op.method} ${op.path}`)
      },
      {
        name: 'Appointment Insights API',
        rationale: 'Best for reporting, event history, and external export jobs.',
        include: operations.filter(op => op.path.includes('/event-messages') || op.path.includes('/exports') || op.path.includes('/batch')).map(op => `${op.method} ${op.path}`)
      }
    ];
    return { content: [{ type: 'json', json: suggestions }] };
  }
);

server.tool(
  'generateConsumerSummary',
  'Generate a concise summary of the API for technical or business audiences.',
  {
    audience: z.enum(['business', 'technical']).default('business')
  },
  async ({ audience }) => {
    const text = audience === 'business'
      ? `The Appointment API manages service-scheduling appointments. It supports browsing appointments, creating and updating bookings, checking capabilities, running business commands such as cancel or reschedule, tracking export jobs, and viewing appointment event history.`
      : `The API is an OpenAPI 3.0.3 Appointment domain service with CRUD endpoints on /appointments, workflow endpoints on /appointments/{appointment_key}/commands, metadata on /appointments/capabilities, asynchronous export endpoints, and event-message retrieval. Primary request schemas include AppointmentCreate and AppointmentUpdate; primary response wrappers include AppointmentResponse and AppointmentListResponse.`;
    return { content: [{ type: 'text', text }] };
  }
);

if (ALLOW_WRITE_TOOLS) {
  server.tool(
    'getRawSpec',
    'Return the full raw OpenAPI document text.',
    {},
    async () => ({ content: [{ type: 'text', text: rawSpec }] })
  );
}

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: SERVER_NAME, spec: path.basename(resolvedSpecPath), operations: operations.length, schemas: Object.keys(schemas).length });
});

app.post('/mcp', async (req: Request, res: Response) => {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => transport.close());
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error('MCP request failure', error);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
    }
  }
});

app.get('/mcp', (_req: Request, res: Response) => {
  res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed. Use POST for MCP requests.' }, id: null });
});

app.listen(PORT, () => {
  console.log(`${SERVER_NAME} listening on port ${PORT}`);
  console.log(`Health: http://localhost:${PORT}/health`);
  console.log(`MCP:    http://localhost:${PORT}/mcp`);
});
