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
const ALLOW_RAW_SPEC = String(process.env.ALLOW_RAW_SPEC || process.env.ALLOW_WRITE_TOOLS || 'false').toLowerCase() === 'true';

const resolvedSpecPath = path.resolve(process.cwd(), SPEC_FILE);
if (!fs.existsSync(resolvedSpecPath)) {
  throw new Error(`SPEC_FILE not found: ${resolvedSpecPath}`);
}

const rawSpec = fs.readFileSync(resolvedSpecPath, 'utf8');
const spec = yaml.load(rawSpec) as Record<string, any>;
const paths = (spec.paths ?? {}) as Record<string, Record<string, any>>;
const schemas = (spec.components?.schemas ?? {}) as Record<string, any>;

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'];

type Operation = {
  path: string;
  method: string;
  operationId: string | null;
  summary: string;
  description: string;
  tags: string[];
  is_write: boolean;
  parameters: Array<Record<string, unknown>>;
  requestBody: any;
  responses: Record<string, unknown>;
};

function isWriteMethod(method: string): boolean {
  return ['post', 'put', 'patch', 'delete'].includes(method.toLowerCase());
}

function listOperations(): Operation[] {
  return Object.entries(paths).flatMap(([route, methods]) =>
    Object.entries(methods)
      .filter(([method]) => HTTP_METHODS.includes(method.toLowerCase()))
      .map(([method, op]) => ({
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

function findOperation(identifier: string): Operation | undefined {
  const normalized = identifier.trim();
  return operations.find(op =>
    op.operationId === normalized ||
    `${op.method} ${op.path}` === normalized ||
    `${op.method.toLowerCase()} ${op.path}` === normalized.toLowerCase()
  );
}

function summarizeForBusiness(op: Operation): string {
  const action = op.summary || op.operationId || `${op.method} ${op.path}`;
  const params = (op.parameters || []).map((p: any) => `${p.name}${p.required ? ' (required)' : ''}`).join(', ');
  const hasBody = !!op.requestBody;
  const writes = op.is_write ? 'This changes data or triggers a workflow.' : 'This reads data only.';
  return `${action}. Route: ${op.method} ${op.path}. ${writes} ${params ? `Main inputs: ${params}.` : ''} ${hasBody ? 'It also accepts a JSON request body.' : ''}`.trim();
}

function inferDomainBuckets() {
  const buckets = [
    { name: 'Core Appointment CRUD', match: (op: Operation) => /^\/appointments(\/\{appointment_key\})?$/.test(op.path) },
    { name: 'Capabilities & metadata', match: (op: Operation) => op.path.includes('/capabilities') },
    { name: 'Bulk and exports', match: (op: Operation) => op.path.includes('/batch') || op.path.includes('/exports') },
    { name: 'Commands / workflows', match: (op: Operation) => op.path.includes('/commands') },
    { name: 'Event messages / audit trail', match: (op: Operation) => op.path.includes('/event-messages') }
  ];
  return buckets.map(bucket => ({
    name: bucket.name,
    operations: operations.filter(bucket.match).map(op => ({
      method: op.method,
      path: op.path,
      operationId: op.operationId,
      summary: op.summary
    }))
  })).filter(b => b.operations.length > 0);
}

function schemaRefsFromNode(node: any, refs = new Set<string>()): Set<string> {
  if (!node || typeof node !== 'object') return refs;
  if (Array.isArray(node)) {
    for (const item of node) schemaRefsFromNode(item, refs);
    return refs;
  }
  const ref = node.$ref;
  if (typeof ref === 'string' && ref.startsWith('#/components/schemas/')) {
    refs.add(ref.split('/').pop() as string);
  }
  for (const value of Object.values(node)) schemaRefsFromNode(value, refs);
  return refs;
}

function getSchemaDependencies(schemaName: string) {
  const seen = new Set<string>();
  const edges: Array<{ from: string; to: string }> = [];

  function walk(name: string) {
    if (seen.has(name)) return;
    seen.add(name);
    const schema = schemas[name];
    if (!schema) return;
    const refs = Array.from(schemaRefsFromNode(schema));
    for (const dep of refs) {
      edges.push({ from: name, to: dep });
      walk(dep);
    }
  }

  walk(schemaName);
  return {
    schema_name: schemaName,
    direct_dependencies: edges.filter(e => e.from === schemaName).map(e => e.to),
    all_dependencies: Array.from(seen).filter(name => name !== schemaName),
    dependency_edges: edges
  };
}

function findOperationSchemaRefs(op: Operation): string[] {
  const refs = new Set<string>();
  schemaRefsFromNode(op.parameters, refs);
  schemaRefsFromNode(op.requestBody, refs);
  schemaRefsFromNode(op.responses, refs);
  return Array.from(refs);
}

function pickOperationsByGroup(group: string): Operation[] {
  const key = group.toLowerCase();
  if (key === 'core' || key === 'appointment-core') {
    return operations.filter(op => /^\/appointments(\/\{appointment_key\})?$/.test(op.path));
  }
  if (key === 'workflow' || key === 'commands') {
    return operations.filter(op => op.path.includes('/commands') || op.path.includes('/capabilities'));
  }
  if (key === 'insights' || key === 'exports' || key === 'events') {
    return operations.filter(op => op.path.includes('/event-messages') || op.path.includes('/exports') || op.path.includes('/batch'));
  }
  if (key === 'customer-facing' || key === 'consumer') {
    return operations.filter(op =>
      /^\/appointments(\/\{appointment_key\})?$/.test(op.path) ||
      op.path.includes('/capabilities') ||
      op.path.includes('/commands')
    );
  }
  return [];
}

function generateReducedSpec(name: string, selectedOperations: Operation[]) {
  const selectedPathMap: Record<string, Record<string, any>> = {};
  const schemaNames = new Set<string>();

  for (const op of selectedOperations) {
    const pathEntry = paths[op.path] ?? {};
    selectedPathMap[op.path] = selectedPathMap[op.path] ?? {};
    selectedPathMap[op.path][op.method.toLowerCase()] = pathEntry[op.method.toLowerCase()];
    for (const ref of findOperationSchemaRefs(op)) {
      schemaNames.add(ref);
      for (const nested of getSchemaDependencies(ref).all_dependencies) schemaNames.add(nested);
    }
  }

  const reducedSchemas: Record<string, any> = {};
  for (const name of Array.from(schemaNames)) {
    if (schemas[name]) reducedSchemas[name] = schemas[name];
  }

  const reduced = {
    openapi: spec.openapi,
    info: {
      title: `${spec.info?.title ?? 'API'} - ${name}`,
      version: spec.info?.version,
      description: `Reduced sub-API generated from ${spec.info?.title ?? 'the source API'} for ${name}.`
    },
    paths: selectedPathMap,
    components: {
      schemas: reducedSchemas
    }
  };

  return yaml.dump(reduced, { noRefs: false, lineWidth: 120 });
}

const app = express();
app.use(express.json({ limit: '1mb' }));

const server = new McpServer({ name: SERVER_NAME, version: '2.0.0' });

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
        read_operations: operations.filter(op => !op.is_write).length,
        write_operations: operations.filter(op => op.is_write).length,
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
    include_read: z.boolean().optional().default(true),
    group: z.enum(['all', 'core', 'workflow', 'insights', 'customer-facing']).optional().default('all')
  },
  async ({ query, include_write = true, include_read = true, group = 'all' }) => {
    const q = query?.toLowerCase().trim();
    const base = group === 'all' ? operations : pickOperationsByGroup(group);
    const filtered = base.filter(op => {
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
  'listWriteOperations',
  'List only operations that create, update, delete, or trigger business workflows.',
  {},
  async () => ({ content: [{ type: 'json', json: operations.filter(op => op.is_write) }] })
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
    return {
      content: [{
        type: 'json',
        json: {
          ...op,
          schema_refs: findOperationSchemaRefs(op)
        }
      }]
    };
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
  'listSchemas',
  'List schema names, optionally filtered by a text query.',
  { query: z.string().optional() },
  async ({ query }) => {
    const q = query?.toLowerCase().trim();
    const result = Object.entries(schemas)
      .filter(([name, schema]: [string, any]) => !q || name.toLowerCase().includes(q) || JSON.stringify(schema).toLowerCase().includes(q))
      .map(([name, schema]: [string, any]) => ({
        name,
        type: schema.type ?? null,
        description: schema.description ?? '',
        required_count: Array.isArray(schema.required) ? schema.required.length : 0,
        property_count: schema.properties ? Object.keys(schema.properties).length : 0
      }));
    return { content: [{ type: 'json', json: result }] };
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
    return {
      content: [{
        type: 'json',
        json: {
          schema_name,
          schema,
          dependencies: getSchemaDependencies(schema_name)
        }
      }]
    };
  }
);

server.tool(
  'getSchemaDependencies',
  'Show direct and transitive schema dependencies for one schema.',
  { schema_name: z.string() },
  async ({ schema_name }) => {
    if (!schemas[schema_name]) {
      return { content: [{ type: 'text', text: `Schema not found: ${schema_name}` }] };
    }
    return { content: [{ type: 'json', json: getSchemaDependencies(schema_name) }] };
  }
);

server.tool(
  'suggestSubApis',
  'Suggest smaller sub-APIs based on the Appointment spec structure.',
  { audience: z.enum(['business', 'technical']).optional().default('technical') },
  async ({ audience = 'technical' }) => {
    const suggestions = [
      {
        name: 'Appointment Core API',
        audience,
        rationale: audience === 'business'
          ? 'Use this when the goal is booking, viewing, updating, or canceling appointments.'
          : 'Best for consumer or channel applications that need CRUD-style appointment operations.',
        include: pickOperationsByGroup('core').map(op => `${op.method} ${op.path}`)
      },
      {
        name: 'Appointment Workflow API',
        audience,
        rationale: audience === 'business'
          ? 'Use this for appointment lifecycle actions such as confirm, cancel, or reschedule.'
          : 'Best for orchestration and state transitions such as commands and capabilities.',
        include: pickOperationsByGroup('workflow').map(op => `${op.method} ${op.path}`)
      },
      {
        name: 'Appointment Insights API',
        audience,
        rationale: audience === 'business'
          ? 'Use this for audit history, export jobs, and operational reporting.'
          : 'Best for reporting, event history, external exports, and bulk-oriented flows.',
        include: pickOperationsByGroup('insights').map(op => `${op.method} ${op.path}`)
      }
    ];
    return { content: [{ type: 'json', json: suggestions }] };
  }
);

server.tool(
  'generateSubApiSpec',
  'Generate a reduced OpenAPI YAML for a named sub-API cut.',
  { sub_api: z.enum(['core', 'workflow', 'insights', 'customer-facing']) },
  async ({ sub_api }) => {
    const selected = pickOperationsByGroup(sub_api);
    if (!selected.length) {
      return { content: [{ type: 'text', text: `No operations matched sub_api=${sub_api}` }] };
    }
    const yamlText = generateReducedSpec(sub_api, selected);
    return { content: [{ type: 'text', text: yamlText }] };
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
      ? `The Appointment API manages service-scheduling appointments. It supports browsing appointments, creating and updating bookings, checking capabilities, running lifecycle commands such as cancel or reschedule, tracking export jobs, and viewing appointment event history.`
      : `The API is an OpenAPI 3.0.3 Appointment domain service with CRUD endpoints on /appointments, workflow endpoints on /appointments/{appointment_key}/commands, metadata on /appointments/capabilities, asynchronous export endpoints, and event-message retrieval. Primary request schemas include AppointmentCreate and AppointmentUpdate; primary response wrappers include AppointmentResponse and AppointmentListResponse.`;
    return { content: [{ type: 'text', text }] };
  }
);

if (ALLOW_RAW_SPEC) {
  server.tool(
    'getRawSpec',
    'Return the full raw OpenAPI document text.',
    {},
    async () => ({ content: [{ type: 'text', text: rawSpec }] })
  );
}

app.get('/', (_req, res) => {
  res.json({
    name: SERVER_NAME,
    status: 'ok',
    health: '/health',
    mcp: '/mcp',
    tools: [
      'getApiOverview',
      'listOperations',
      'listWriteOperations',
      'getOperationDetails',
      'explainOperationForBusiness',
      'listSchemas',
      'getSchema',
      'getSchemaDependencies',
      'suggestSubApis',
      'generateSubApiSpec',
      'generateConsumerSummary'
    ]
  });
});

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: SERVER_NAME,
    spec: path.basename(resolvedSpecPath),
    operations: operations.length,
    schemas: Object.keys(schemas).length,
    version: '2.0.0'
  });
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
