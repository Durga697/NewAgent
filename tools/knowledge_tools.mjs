import { ToolError } from './errors.mjs';
import { requirePermit } from '../safety/policy.mjs';

function requireKnowledge(context) {
  if (!context?.knowledge) {
    throw new ToolError('OPERATION_FAILED', 'Private Knowledge engine is unavailable.');
  }
  return context.knowledge;
}

const CITATION_SCHEMA = {
  type: 'object',
  properties: {
    citationNumber: { type: 'integer' },
    documentId: { type: 'string' },
    fileName: { type: 'string' },
    chunkId: { type: 'string' },
    chunkIndex: { type: 'integer' },
    section: { type: 'string' },
    snippet: { type: 'string' },
    highlightText: { type: 'string' },
    score: { type: 'number' }
  },
  required: ['citationNumber', 'documentId', 'fileName', 'chunkId', 'chunkIndex', 'section', 'snippet', 'highlightText', 'score'],
  additionalProperties: false
};

const TABLE_SCHEMA = {
  type: 'object',
  properties: {
    documentId: { type: 'string' },
    fileName: { type: 'string' },
    title: { type: 'string' },
    headers: { type: 'array', items: { type: 'string' } },
    rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } }
  },
  required: ['title', 'headers', 'rows'],
  additionalProperties: false
};

const QA_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    answer: { type: 'string' },
    mode: { type: 'string' },
    selectedOnly: { type: 'boolean' },
    scopedDocumentCount: { type: 'integer' },
    localOnly: { type: 'boolean', const: true },
    citations: { type: 'array', items: CITATION_SCHEMA },
    tables: { type: 'array', items: TABLE_SCHEMA }
  },
  required: ['answer', 'mode', 'selectedOnly', 'scopedDocumentCount', 'localOnly', 'citations', 'tables'],
  additionalProperties: false
};

export const knowledgeSearchTool = {
  id: 'knowledge.search',
  name: 'knowledge_search',
  description: 'Search locally indexed private knowledge documents semantically and lexically without sending content to external models.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', minLength: 1, maxLength: 300 },
      collectionId: { type: 'string', maxLength: 80 },
      documentIds: { type: 'array', maxItems: 50, items: { type: 'string', maxLength: 80 } },
      limit: { type: 'integer', minimum: 1, maximum: 25 }
    },
    required: ['query'],
    additionalProperties: false
  },
  outputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      scopedDocumentCount: { type: 'integer' },
      localOnly: { type: 'boolean', const: true },
      results: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            chunkId: { type: 'string' },
            documentId: { type: 'string' },
            collectionId: { type: 'string' },
            fileName: { type: 'string' },
            chunkIndex: { type: 'integer' },
            section: { type: 'string' },
            snippet: { type: 'string' },
            score: { type: 'number' }
          },
          required: ['chunkId', 'documentId', 'collectionId', 'fileName', 'chunkIndex', 'section', 'snippet', 'score'],
          additionalProperties: false
        }
      }
    },
    required: ['query', 'scopedDocumentCount', 'localOnly', 'results'],
    additionalProperties: false
  },
  async run(context, args) {
    requirePermit(context.execution, context.session, 'knowledge_search');
    const kb = requireKnowledge(context);
    const found = kb.search(context.ownerKey, {
      query: args.query,
      collectionId: args.collectionId || null,
      documentIds: args.documentIds || null,
      limit: args.limit || 8
    });
    return {
      query: found.query,
      scopedDocumentCount: found.scopedDocumentCount,
      localOnly: true,
      results: found.results.map((r) => ({
        chunkId: r.chunkId,
        documentId: r.documentId,
        collectionId: r.collectionId,
        fileName: r.fileName,
        chunkIndex: r.chunkIndex,
        section: r.section,
        snippet: r.content.slice(0, 300),
        score: r.score
      }))
    };
  }
};

export const knowledgeAnswerTool = {
  id: 'knowledge.answer',
  name: 'knowledge_answer',
  description: 'Answer a question locally with grounded citations from indexed documents or selected document IDs.',
  parameters: {
    type: 'object',
    properties: {
      question: { type: 'string', minLength: 1, maxLength: 600 },
      collectionId: { type: 'string', maxLength: 80 },
      documentIds: { type: 'array', maxItems: 50, items: { type: 'string', maxLength: 80 } },
      selectedOnly: { type: 'boolean' }
    },
    required: ['question'],
    additionalProperties: false
  },
  outputSchema: QA_OUTPUT_SCHEMA,
  async run(context, args) {
    requirePermit(context.execution, context.session, 'knowledge_answer');
    const kb = requireKnowledge(context);
    return kb.chat(context.ownerKey, {
      question: args.question,
      collectionId: args.collectionId || null,
      documentIds: args.documentIds || null,
      mode: 'qa',
      selectedOnly: Boolean(args.selectedOnly)
    });
  }
};

export const knowledgeSummarizeTool = {
  id: 'knowledge.summarize',
  name: 'knowledge_summarize',
  description: 'Summarize indexed documents locally with source citations and metadata.',
  parameters: {
    type: 'object',
    properties: {
      prompt: { type: 'string', maxLength: 400 },
      collectionId: { type: 'string', maxLength: 80 },
      documentIds: { type: 'array', maxItems: 50, items: { type: 'string', maxLength: 80 } }
    },
    additionalProperties: false
  },
  outputSchema: QA_OUTPUT_SCHEMA,
  async run(context, args) {
    requirePermit(context.execution, context.session, 'knowledge_summarize');
    const kb = requireKnowledge(context);
    return kb.chat(context.ownerKey, {
      question: args.prompt || '',
      collectionId: args.collectionId || null,
      documentIds: args.documentIds || null,
      mode: 'summarize',
      selectedOnly: Boolean(args.documentIds?.length)
    });
  }
};

export const knowledgeCompareTool = {
  id: 'knowledge.compare',
  name: 'knowledge_compare',
  description: 'Compare 2 or more indexed documents side-by-side locally (e.g., offer letters or contracts).',
  parameters: {
    type: 'object',
    properties: {
      collectionId: { type: 'string', maxLength: 80 },
      documentIds: { type: 'array', maxItems: 10, items: { type: 'string', maxLength: 80 } }
    },
    additionalProperties: false
  },
  outputSchema: QA_OUTPUT_SCHEMA,
  async run(context, args) {
    requirePermit(context.execution, context.session, 'knowledge_compare');
    const kb = requireKnowledge(context);
    return kb.chat(context.ownerKey, {
      collectionId: args.collectionId || null,
      documentIds: args.documentIds || null,
      mode: 'compare',
      selectedOnly: Boolean(args.documentIds?.length)
    });
  }
};

export const knowledgeExtractTablesTool = {
  id: 'knowledge.extract_tables',
  name: 'knowledge_extract_tables',
  description: 'Extract structured tables from indexed PDF, DOCX, CSV, XLSX, or Markdown documents.',
  parameters: {
    type: 'object',
    properties: {
      collectionId: { type: 'string', maxLength: 80 },
      documentIds: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 80 } }
    },
    additionalProperties: false
  },
  outputSchema: QA_OUTPUT_SCHEMA,
  async run(context, args) {
    requirePermit(context.execution, context.session, 'knowledge_extract_tables');
    const kb = requireKnowledge(context);
    return kb.chat(context.ownerKey, {
      collectionId: args.collectionId || null,
      documentIds: args.documentIds || null,
      mode: 'tables',
      selectedOnly: Boolean(args.documentIds?.length)
    });
  }
};

export const knowledgeIngestFolderTool = {
  id: 'knowledge.ingest_folder',
  name: 'knowledge_ingest_folder',
  description: 'Index supported local documents inside an authorized folder into a Private Knowledge collection after confirmation.',
  parameters: {
    type: 'object',
    properties: {
      folder: { type: 'string', minLength: 1, maxLength: 120 },
      collectionId: { type: 'string', maxLength: 80 },
      ocrEnabled: { type: 'boolean' }
    },
    required: ['folder'],
    additionalProperties: false
  },
  outputSchema: {
    type: 'object',
    properties: {
      status: { type: 'string', const: 'completed' },
      collectionId: { type: 'string' },
      folder: { type: 'string' },
      indexedCount: { type: 'integer' },
      unchangedCount: { type: 'integer' },
      skippedCount: { type: 'integer' },
      errorCount: { type: 'integer' }
    },
    required: ['status', 'collectionId', 'folder', 'indexedCount', 'unchangedCount', 'skippedCount', 'errorCount'],
    additionalProperties: false
  },
  targetIds(args) {
    return [`folder:${args.folder}`];
  },
  preview(args, context) {
    if (!context?.files?.config?.enabled) {
      throw new ToolError('FILES_DISABLED', 'Local folder indexing is disabled in this environment.');
    }
    const matched = (context.files.config.roots || []).find(
      (r) => r.id.toLowerCase() === String(args.folder || '').trim().toLowerCase()
    );
    if (!matched) {
      throw new ToolError('OUTSIDE_ALLOWLIST', `Folder "${args.folder}" is not an authorized root.`);
    }
    return `Index supported documents in authorized folder "${matched.id}" locally into Private Knowledge (content remains local-only; OCR ${args.ocrEnabled ? 'enabled' : 'disabled'}).`;
  },
  async run(context, args) {
    requirePermit(context.execution, context.session, 'knowledge_ingest_folder');
    const kb = requireKnowledge(context);
    const res = await kb.ingestAuthorizedFolder(context.session, context.ownerKey, {
      folder: args.folder,
      collectionId: args.collectionId || null,
      ocrEnabled: args.ocrEnabled
    });
    return {
      status: 'completed',
      collectionId: res.collectionId,
      folder: res.folder,
      indexedCount: res.indexedCount,
      unchangedCount: res.unchangedCount,
      skippedCount: res.skippedCount,
      errorCount: res.errorCount
    };
  }
};

export const knowledgeTools = [
  knowledgeSearchTool,
  knowledgeAnswerTool,
  knowledgeSummarizeTool,
  knowledgeCompareTool,
  knowledgeExtractTablesTool,
  knowledgeIngestFolderTool
];
