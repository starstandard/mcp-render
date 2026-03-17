import 'dotenv/config';
import crypto from 'node:crypto';
import express, { type Request, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const PORT = Number(process.env.PORT || 4000);
const SERVER_NAME = process.env.SERVER_NAME || 'appointment-metadata-mcp';
const ALLOW_RAW_SPEC =
  String(process.env.ALLOW_RAW_SPEC || process.env.ALLOW_WRITE_TOOLS || 'false').toLowerCase() === 'true';

const SPEC_FILES = [
  './openapi/appointment-api.yaml',
  './openapi/multi-point-inspection-api.yaml'
];

type LoadedApi = {
  domain_name: string;
  raw: string;
  spec: Record<string, any>;
  paths: Record<string, Record<string, any>>;
  schemas: Record<string, any>;
};

type Operation = {
  domain_name: string;
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

const loadedApis: LoadedApi[] = SPEC_FILES.map((filePath) => {
  const resolvedPath = path.resolve(process.cwd(), filePath);

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Spec not found: ${resolvedPath}`);
  }

  const raw = fs.readFileSync(resolvedPath, 'utf8');
  const parsed = yaml.load(raw) as Record<string, any>;

  const domain_name = filePath.includes('multi-point')
    ? 'multi-point-inspection'
    : 'appointment';

  return {
    domain_name,
    raw,
    spec: parsed,
    paths: (parsed.paths ?? {}) as Record<string, Record<string, any>>,
    schemas: (parsed.components?.schemas ?? {}) as Record<string, any>
  };
});

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'];

function isWriteMethod(method: string): boolean {
  return ['post', 'put', 'patch', 'delete'].includes(method.toLowerCase());
}

function listOperationsInternal(
  apiPaths: Record<string, Record<string, any>>
): Omit<Operation, 'domain_name'>[] {
  return Object.entries(apiPaths).flatMap(([route, methods]) =>
    Object.entries(methods)
      .filter(([method]) => HTTP_METHODS.includes(method.toLowerCase()))
      .map(([method, op]) => {
        const operation = op as Record<string, any>;
        return {
          path: route,
          method: method.toUpperCase(),
          operationId: (operation.operationId as string | undefined) ?? null,
          summary: (operation.summary as string | undefined) ?? '',
          description: (operation.description as string | undefined) ?? '',
          tags: (operation.tags as string[] | undefined) ?? [],
          is_write: isWriteMethod(method),
          parameters: ((operation.parameters as any[]) ?? []).map((p: any) => ({
            name: p.name,
            in: p.in,
            required: !!p.required,
            schema: p.schema ?? null,
            description: p.description ?? ''
          })),
          requestBody: operation.requestBody ?? null,
          responses: (operation.responses as Record<string, unknown>) ?? {}
        };
      })
  );
}

const operations: Operation[] = loadedApis.flatMap((api) =>
  listOperationsInternal(api.paths).map((op) => ({
    ...op,
    domain_name: api.domain_name
  }))
);

function jsonToolResult(data: unknown, label?: string) {
  return {
    structuredContent: data,
    content: [
      {
        type: 'text' as const,
        text: label
          ? `${label}\n\n${JSON.stringify(data, null, 2)}`
          : JSON.stringify(data, null, 2)
      }
    ]
  };
}

function textToolResult(text: string) {
  return {
    content: [{ type: 'text' as const, text }]
  };
}

function safeErrorResult(message: string) {
  return textToolResult(message);
}

function findOperation(identifier: string, domain_name?: string): Operation | undefined {
  const normalized = identifier.trim();

  return operations.find((op) => {
    if (domain_name && op.domain_name !== domain_name) return false;

    return (
      op.operationId === normalized ||
      `${op.method} ${op.path}` === normalized ||
      `${op.method.toLowerCase()} ${op.path}` === normalized.toLowerCase()
    );
  });
}

function summarizeForBusiness(op: Operation): string {
  const action = op.summary || op.operationId || `${op.method} ${op.path}`;
  const params = (op.parameters || [])
    .map((p: any) => `${p.name}${p.required ? ' (required)' : ''}`)
    .join(', ');
  const hasBody = !!op.requestBody;
  const writes = op.is_write
    ? 'This changes data or triggers a workflow.'
    : 'This reads data only.';

  return `${action}. Route: ${op.method} ${op.path}. ${writes} ${
    params ? `Main inputs: ${params}.` : ''
  } ${hasBody ? 'It also accepts a JSON request body.' : ''}`.trim();
}

function inferAppointmentBuckets() {
  const buckets = [
    {
      name: 'Core Appointment CRUD',
      match: (op: Operation) => op.domain_name === 'appointment' && /^\/appointments(\/\{appointment_key\})?$/.test(op.path)
    },
    {
      name: 'Capabilities & metadata',
      match: (op: Operation) => op.domain_name === 'appointment' && op.path.includes('/capabilities')
    },
    {
      name: 'Bulk and exports',
      match: (op: Operation) => op.domain_name === 'appointment' && (op.path.includes('/batch') || op.path.includes('/exports'))
    },
    {
      name: 'Commands / workflows',
      match: (op: Operation) => op.domain_name === 'appointment' && op.path.includes('/commands')
    },
    {
      name: 'Event messages / audit trail',
      match: (op: Operation) => op.domain_name === 'appointment' && op.path.includes('/event-messages')
    }
  ];

  return buckets
    .map((bucket) => ({
      name: bucket.name,
      operations: operations.filter(bucket.match).map((op) => ({
        domain_name: op.domain_name,
        method: op.method,
        path: op.path,
        operationId: op.operationId,
        summary: op.summary
      }))
    }))
    .filter((b) => b.operations.length > 0);
}

function schemaRefsFromNode(node: any, refs = new Set<string>()): Set<string> {
  if (!node || typeof node !== 'object') return refs;

  if (Array.isArray(node)) {
    for (const item of node) {
      schemaRefsFromNode(item, refs);
    }
    return refs;
  }

  const ref = node.$ref;
  if (typeof ref === 'string' && ref.startsWith('#/components/schemas/')) {
    refs.add(ref.split('/').pop() as string);
  }

  for (const value of Object.values(node)) {
    schemaRefsFromNode(value, refs);
  }

  return refs;
}

function findOperationSchemaRefs(op: Operation): string[] {
  const refs = new Set<string>();
  schemaRefsFromNode(op.parameters, refs);
  schemaRefsFromNode(op.requestBody, refs);
  schemaRefsFromNode(op.responses, refs);
  return Array.from(refs);
}

function getSchemaDependencies(domainSchemas: Record<string, any>, schemaName: string) {
  const seen = new Set<string>();
  const edges: Array<{ from: string; to: string }> = [];

  function walk(name: string) {
    if (seen.has(name)) return;
    seen.add(name);

    const schema = domainSchemas[name];
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
    direct_dependencies: edges.filter((e) => e.from === schemaName).map((e) => e.to),
    all_dependencies: Array.from(seen).filter((name) => name !== schemaName),
    dependency_edges: edges
  };
}

function pickOperationsByGroup(group: string, domain_name?: string): Operation[] {
  const key = group.toLowerCase();

  const scopedOperations = domain_name
    ? operations.filter((op) => op.domain_name === domain_name)
    : operations;

  if (key === 'core' || key === 'appointment-core') {
    return scopedOperations.filter((op) =>
      /^\/appointments(\/\{appointment_key\})?$/.test(op.path)
    );
  }

  if (key === 'workflow' || key === 'commands') {
    return scopedOperations.filter(
      (op) => op.path.includes('/commands') || op.path.includes('/capabilities')
    );
  }

  if (key === 'insights' || key === 'exports' || key === 'events') {
    return scopedOperations.filter(
      (op) =>
        op.path.includes('/event-messages') ||
        op.path.includes('/exports') ||
        op.path.includes('/batch')
    );
  }

  if (key === 'customer-facing' || key === 'consumer') {
    return scopedOperations.filter(
      (op) =>
        /^\/appointments(\/\{appointment_key\})?$/.test(op.path) ||
        op.path.includes('/capabilities') ||
        op.path.includes('/commands')
    );
  }

  return [];
}

function generateReducedSpec(name: string, selectedOperations: Operation[]) {
  const appointmentApi = loadedApis.find((api) => api.domain_name === 'appointment');
  if (!appointmentApi) {
    throw new Error('Appointment API not loaded');
  }

  const selectedPathMap: Record<string, Record<string, any>> = {};
  const schemaNames = new Set<string>();

  for (const op of selectedOperations) {
    const pathEntry = appointmentApi.paths[op.path] ?? {};
    selectedPathMap[op.path] = selectedPathMap[op.path] ?? {};
    selectedPathMap[op.path][op.method.toLowerCase()] = pathEntry[op.method.toLowerCase()];

    for (const ref of findOperationSchemaRefs(op)) {
      schemaNames.add(ref);
      for (const nested of getSchemaDependencies(appointmentApi.schemas, ref).all_dependencies) {
        schemaNames.add(nested);
      }
    }
  }

  const reducedSchemas: Record<string, any> = {};
  for (const schemaName of Array.from(schemaNames)) {
    if (appointmentApi.schemas[schemaName]) {
      reducedSchemas[schemaName] = appointmentApi.schemas[schemaName];
    }
  }

  const reduced = {
    openapi: appointmentApi.spec.openapi,
    info: {
      title: `${appointmentApi.spec.info?.title ?? 'API'} - ${name}`,
      version: appointmentApi.spec.info?.version,
      description: `Reduced sub-API generated from ${appointmentApi.spec.info?.title ?? 'the source API'} for ${name}.`
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
let openAiTransport: StreamableHTTPServerTransport | null = null;

async function handleOpenAiMcpRequest(req: Request, res: Response) {
  if (!openAiTransport) {
    openAiTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined
    });

    openAiTransport.onclose = () => {
      openAiTransport = null;
    };

    await server.connect(openAiTransport);
  }

  await openAiTransport.handleRequest(req, res, req.body);
}
server.tool(
  'getApiOverview',
  'Return a high-level summary of one API domain or all loaded API domains.',
  {
    domain_name: z.string().optional()
  },
  async ({ domain_name }) => {
    try {
      const matchingApis = domain_name
        ? loadedApis.filter((api) => api.domain_name === domain_name)
        : loadedApis;

      if (!matchingApis.length) {
        return safeErrorResult(`Domain not found: ${domain_name}`);
      }

      const overview = matchingApis.map((api) => {
        const apiOperations = operations.filter((op) => op.domain_name === api.domain_name);
        const apiSchemas = api.schemas ?? {};

        return {
          domain_name: api.domain_name,
          openapi: api.spec.openapi,
          title: api.spec.info?.title,
          version: api.spec.info?.version,
          description: api.spec.info?.description,
          operation_count: apiOperations.length,
          schema_count: Object.keys(apiSchemas).length,
          read_operations: apiOperations.filter((op) => !op.is_write).length,
          write_operations: apiOperations.filter((op) => op.is_write).length,
          domain_buckets: api.domain_name === 'appointment' ? inferAppointmentBuckets() : []
        };
      });

      return jsonToolResult(
        domain_name ? overview[0] : { domains: overview },
        domain_name ? `Overview for ${domain_name}` : 'Overview for all loaded domains'
      );
    } catch (error: any) {
      console.error('getApiOverview failed', error);
      return safeErrorResult(`getApiOverview failed: ${error?.message ?? String(error)}`);
    }
  }
);

server.tool(
  'listOperations',
  'List all operations, optionally filtering by domain, text, or by read vs write intent.',
  {
    domain_name: z.string().optional(),
    query: z.string().optional(),
    include_write: z.boolean().optional().default(true),
    include_read: z.boolean().optional().default(true),
    group: z.enum(['all', 'core', 'workflow', 'insights', 'customer-facing']).optional().default('all'),
    limit: z.number().int().min(1).max(200).optional().default(100)
  },
  async ({ domain_name, query, include_write = true, include_read = true, group = 'all', limit = 100 }) => {
    try {
      const q = query?.toLowerCase().trim();
      const base = group === 'all' ? operations : pickOperationsByGroup(group, domain_name);

      const filtered = base.filter((op) => {
        if (domain_name && op.domain_name !== domain_name) return false;
        if (op.is_write && !include_write) return false;
        if (!op.is_write && !include_read) return false;
        if (!q) return true;
        const hay = JSON.stringify(op).toLowerCase();
        return hay.includes(q);
      });

      const limited = filtered.slice(0, limit);

      return jsonToolResult(
        {
          domain_name: domain_name ?? 'all',
          count: filtered.length,
          returned: limited.length,
          limit,
          operations: limited
        },
        'Matching operations'
      );
    } catch (error: any) {
      console.error('listOperations failed', error);
      return safeErrorResult(`listOperations failed: ${error?.message ?? String(error)}`);
    }
  }
);

server.tool(
  'listWriteOperations',
  'List only operations that create, update, delete, or trigger business workflows.',
  {
    limit: z.number().int().min(1).max(200).optional().default(100)
  },
  async ({ limit = 100 }) => {
    try {
      const result = operations.filter((op) => op.is_write);
      const limited = result.slice(0, limit);

      return jsonToolResult(
        {
          count: result.length,
          returned: limited.length,
          limit,
          operations: limited
        },
        'Write operations'
      );
    } catch (error: any) {
      console.error('listWriteOperations failed', error);
      return safeErrorResult(`listWriteOperations failed: ${error?.message ?? String(error)}`);
    }
  }
);

server.tool(
  'listDomains',
  'List available API domains loaded in this MCP server.',
  {},
  async () => ({
    content: [
      {
        type: 'json',
        json: {
          domains: loadedApis.map((api) => api.domain_name)
        }
      }
    ]
  })
);

server.tool(
  'getOperationDetails',
  'Get details for one operation by operationId or exact "METHOD /path", optionally scoped to a domain.',
  {
    domain_name: z.string().optional(),
    identifier: z.string()
  },
  async ({ domain_name, identifier }) => {
    try {
      const op = findOperation(identifier, domain_name);
      if (!op) {
        return safeErrorResult(
          domain_name
            ? `Operation not found in domain '${domain_name}': ${identifier}`
            : `Operation not found: ${identifier}`
        );
      }

      return jsonToolResult(
        {
          ...op,
          schema_refs: findOperationSchemaRefs(op),
          domain_name: op.domain_name
        },
        `Operation details for ${identifier}`
      );
    } catch (error: any) {
      console.error('getOperationDetails failed', error);
      return safeErrorResult(`getOperationDetails failed: ${error?.message ?? String(error)}`);
    }
  }
);

server.tool(
  'explainOperationForBusiness',
  'Explain an operation in plain language for non-technical stakeholders.',
  {
    identifier: z.string()
  },
  async ({ identifier }) => {
    try {
      const op = findOperation(identifier);
      if (!op) {
        return safeErrorResult(`Operation not found: ${identifier}`);
      }
      return textToolResult(summarizeForBusiness(op));
    } catch (error: any) {
      console.error('explainOperationForBusiness failed', error);
      return safeErrorResult(`explainOperationForBusiness failed: ${error?.message ?? String(error)}`);
    }
  }
);

server.tool(
  'listSchemas',
  'List schema names, optionally filtered by domain and text query.',
  {
    domain_name: z.string().optional(),
    query: z.string().optional(),
    limit: z.number().int().min(1).max(200).optional().default(100)
  },
  async ({ domain_name, query, limit = 100 }) => {
    try {
      const q = query?.toLowerCase().trim();

      const matchingApis = domain_name
        ? loadedApis.filter((api) => api.domain_name === domain_name)
        : loadedApis;

      if (!matchingApis.length) {
        return safeErrorResult(`Domain not found: ${domain_name}`);
      }

      const result = matchingApis.flatMap((api) =>
        Object.entries(api.schemas ?? {})
          .filter(
            ([name, schema]: [string, any]) =>
              !q ||
              name.toLowerCase().includes(q) ||
              JSON.stringify(schema).toLowerCase().includes(q)
          )
          .map(([name, schema]: [string, any]) => ({
            domain_name: api.domain_name,
            name,
            type: schema.type ?? null,
            description: schema.description ?? '',
            required_count: Array.isArray(schema.required) ? schema.required.length : 0,
            property_count: schema.properties ? Object.keys(schema.properties).length : 0
          }))
      );

      const limited = result.slice(0, limit);

      return jsonToolResult(
        {
          domain_name: domain_name ?? 'all',
          count: result.length,
          returned: limited.length,
          limit,
          schemas: limited
        },
        'Matching schemas'
      );
    } catch (error: any) {
      console.error('listSchemas failed', error);
      return safeErrorResult(`listSchemas failed: ${error?.message ?? String(error)}`);
    }
  }
);

server.tool(
  'getSchema',
  'Return a schema definition by exact schema name from a specific domain or from all loaded domains.',
  {
    domain_name: z.string().optional(),
    schema_name: z.string()
  },
  async ({ domain_name, schema_name }) => {
    try {
      const matchingApis = domain_name
        ? loadedApis.filter((api) => api.domain_name === domain_name)
        : loadedApis;

      if (!matchingApis.length) {
        return safeErrorResult(`Domain not found: ${domain_name}`);
      }

      const matches = matchingApis
        .filter((api) => api.schemas && api.schemas[schema_name])
        .map((api) => ({
          domain_name: api.domain_name,
          schema: api.schemas[schema_name]
        }));

      if (!matches.length) {
        return safeErrorResult(
          domain_name
            ? `Schema not found in domain '${domain_name}': ${schema_name}`
            : `Schema not found: ${schema_name}`
        );
      }

      if (!domain_name && matches.length > 1) {
        return jsonToolResult(
          {
            schema_name,
            message: 'Schema exists in multiple domains. Please provide domain_name.',
            matches: matches.map((m) => ({ domain_name: m.domain_name }))
          },
          `Schema '${schema_name}' found in multiple domains`
        );
      }

      const selected = matches[0];
      const selectedApi = matchingApis.find((api) => api.domain_name === selected.domain_name)!;

      return jsonToolResult(
        {
          domain_name: selected.domain_name,
          schema_name,
          schema: selected.schema,
          dependencies: getSchemaDependencies(selectedApi.schemas, schema_name)
        },
        `Schema details for ${schema_name}`
      );
    } catch (error: any) {
      console.error('getSchema failed', error);
      return safeErrorResult(`getSchema failed: ${error?.message ?? String(error)}`);
    }
  }
);

server.tool(
  'suggestSubApis',
  'Suggest smaller sub-APIs based on the Appointment spec structure.',
  {
    audience: z.enum(['business', 'technical']).optional().default('technical')
  },
  async ({ audience = 'technical' }) => {
    try {
      const suggestions = [
        {
          name: 'Appointment Core API',
          audience,
          rationale:
            audience === 'business'
              ? 'Use this when the goal is booking, viewing, updating, or canceling appointments.'
              : 'Best for consumer or channel applications that need CRUD-style appointment operations.',
          include: pickOperationsByGroup('core', 'appointment').map((op) => `${op.method} ${op.path}`)
        },
        {
          name: 'Appointment Workflow API',
          audience,
          rationale:
            audience === 'business'
              ? 'Use this for appointment lifecycle actions such as confirm, cancel, or reschedule.'
              : 'Best for orchestration and state transitions such as commands and capabilities.',
          include: pickOperationsByGroup('workflow', 'appointment').map((op) => `${op.method} ${op.path}`)
        },
        {
          name: 'Appointment Insights API',
          audience,
          rationale:
            audience === 'business'
              ? 'Use this for audit history, export jobs, and operational reporting.'
              : 'Best for reporting, event history, external exports, and bulk-oriented flows.',
          include: pickOperationsByGroup('insights', 'appointment').map((op) => `${op.method} ${op.path}`)
        }
      ];

      return jsonToolResult(suggestions, 'Suggested sub-APIs');
    } catch (error: any) {
      console.error('suggestSubApis failed', error);
      return safeErrorResult(`suggestSubApis failed: ${error?.message ?? String(error)}`);
    }
  }
);

server.tool(
  'generateSubApiSpec',
  'Generate a reduced OpenAPI YAML for a named sub-API cut.',
  {
    sub_api: z.enum(['core', 'workflow', 'insights', 'customer-facing'])
  },
  async ({ sub_api }) => {
    try {
      const selected = pickOperationsByGroup(sub_api, 'appointment');
      if (!selected.length) {
        return safeErrorResult(`No operations matched sub_api=${sub_api}`);
      }

      const yamlText = generateReducedSpec(sub_api, selected);
      return textToolResult(yamlText);
    } catch (error: any) {
      console.error('generateSubApiSpec failed', error);
      return safeErrorResult(`generateSubApiSpec failed: ${error?.message ?? String(error)}`);
    }
  }
);

server.tool(
  'generateConsumerSummary',
  'Generate a concise summary of the API for technical or business audiences.',
  {
    audience: z.enum(['business', 'technical']).default('business')
  },
  async ({ audience }) => {
    try {
      const text =
        audience === 'business'
          ? `The Appointment API manages service-scheduling appointments. It supports browsing appointments, creating and updating bookings, checking capabilities, running lifecycle commands such as cancel or reschedule, tracking export jobs, and viewing appointment event history.`
          : `The API is an OpenAPI 3.0.3 Appointment domain service with CRUD endpoints on /appointments, workflow endpoints on /appointments/{appointment_key}/commands, metadata on /appointments/capabilities, asynchronous export endpoints, and event-message retrieval. Primary request schemas include AppointmentCreate and AppointmentUpdate; primary response wrappers include AppointmentResponse and AppointmentListResponse.`;

      return textToolResult(text);
    } catch (error: any) {
      console.error('generateConsumerSummary failed', error);
      return safeErrorResult(`generateConsumerSummary failed: ${error?.message ?? String(error)}`);
    }
  }
);

if (ALLOW_RAW_SPEC) {
  server.tool(
    'getRawSpec',
    'Return the full raw OpenAPI document text for a domain.',
    {
      domain_name: z.string().optional().default('appointment')
    },
    async ({ domain_name = 'appointment' }) => {
      const api = loadedApis.find((a) => a.domain_name === domain_name);
      if (!api) {
        return safeErrorResult(`Domain not found: ${domain_name}`);
      }
      return textToolResult(api.raw);
    }
  );
}

app.get('/', (_req, res) => {
  res.json({
    name: SERVER_NAME,
    status: 'ok',
    health: '/health',
    mcp: '/mcp',
    openai_mcp: '/openai-mcp',
    domains: loadedApis.map((api) => api.domain_name),
    tools: [
      'listDomains',
      'getApiOverview',
      'listOperations',
      'listWriteOperations',
      'getOperationDetails',
      'explainOperationForBusiness',
      'listSchemas',
      'getSchema',
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
    domains: loadedApis.map((api) => api.domain_name),
    api_count: loadedApis.length,
    operations: operations.length,
    schemas: loadedApis.reduce(
      (total, api) => total + Object.keys(api.schemas ?? {}).length,
      0
    ),
    version: '2.0.0'
  });
});

async function handleClaudeMcpRequest(req: Request, res: Response) {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined
  });

  res.on('close', () => transport.close());

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error('Claude MCP request failure', error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null
      });
    }
  }
}


  let transport: StreamableHTTPServerTransport | undefined;

  if (sessionId && openAiTransports.has(sessionId)) {
    transport = openAiTransports.get(sessionId);
  } else {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (newSessionId) => {
        openAiTransports.set(newSessionId, transport!);
      }
    });

    transport.onclose = () => {
      const sid = transport?.sessionId;
      if (sid) {
        openAiTransports.delete(sid);
      }
    };

    await server.connect(transport);
  }

  await transport.handleRequest(req, res, req.body);


// Claude-compatible endpoint
app.post('/mcp', async (req: Request, res: Response) => {
  console.log(`Claude MCP route hit: ${req.method} /mcp`);
  await handleClaudeMcpRequest(req, res);
});

app.get('/mcp', (_req: Request, res: Response) => {
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed. Use POST for MCP requests.' },
    id: null
  });
});

// OpenAI-facing endpoint
app.all('/openai-mcp', async (req: Request, res: Response) => {
  try {
    console.log(`OpenAI MCP route hit: ${req.method} /openai-mcp`);
    await handleOpenAiMcpRequest(req, res);
  } catch (error) {
    console.error('OpenAI MCP request failure', error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null
      });
    }
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`${SERVER_NAME} listening on port ${PORT}`);
  console.log(`Health:      http://0.0.0.0:${PORT}/health`);
  console.log(`Claude MCP:  http://0.0.0.0:${PORT}/mcp`);
  console.log(`OpenAI MCP:  http://0.0.0.0:${PORT}/openai-mcp`);
});
