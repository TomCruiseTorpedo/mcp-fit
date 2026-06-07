/**
 * Strawman MCP server — deliberately bad.
 *
 * Exhibits one anti-pattern per mcp-fit scorecard axis:
 *
 *   namespacing           — tools named "process", "get", "change", "remove": vague,
 *                           no domain prefix, inconsistent vocabulary
 *   tool-selection-confusion — "search" and "find" both search notes with overlapping
 *                           descriptions; agent cannot reliably choose
 *   param-strictness      — all params use bare "string" type with no descriptions,
 *                           no enums where applicable ("type" on process, "type" on find)
 *   output-leanness       — every tool returns labeled prose instead of structured data:
 *                           "The item with identifier X was found. The title is Y. ..."
 *   error-helpfulness     — errors are opaque ("An error occurred.", "Operation failed.")
 *                           with no recovery guidance
 *
 * Domain: in-memory note store. Seeded with two notes so tasks can start immediately.
 * The server is intentionally kept minimal — no persistence, no auth.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// ---------------------------------------------------------------------------
// In-memory note store — seeded for tasks
// ---------------------------------------------------------------------------

interface Note {
  id: string;
  title: string;
  content: string;
  tags: string;
  created: string;
}

const notes: Record<string, Note> = {
  "note-1": {
    id: "note-1",
    title: "Introduction",
    content: "Welcome to the system. This note introduces the workspace.",
    tags: "intro,welcome",
    created: "2026-01-01",
  },
  "note-2": {
    id: "note-2",
    title: "Meeting",
    content: "Q1 review scheduled for next week. Bring the numbers.",
    tags: "meeting,q1",
    created: "2026-01-15",
  },
};

let nextId = 3;

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = new Server(
  { name: "strawman", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

// ---------------------------------------------------------------------------
// tools/list
// ---------------------------------------------------------------------------

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    // ANTI-PATTERN: namespacing + param-strictness
    // Name "process" is vague — should be "create_note".
    // Tool description doesn't say what it creates.
    // Params "data" and "type" have no descriptions, no enums.
    {
      name: "process",
      description: "Process data",
      inputSchema: {
        type: "object" as const,
        properties: {
          data: { type: "string" },
          type: { type: "string" },
        },
        required: ["data"],
      },
    },

    // ANTI-PATTERN: namespacing + param-strictness
    // Name "get" is vague and conflicts with HTTP semantics.
    // Should be "get_note". Param "id" has no description.
    {
      name: "get",
      description: "Get",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: { type: "string" },
        },
        required: ["id"],
      },
    },

    // ANTI-PATTERN: tool-selection-confusion + param-strictness
    // "search" and "find" (below) both search notes.
    // Descriptions are almost identical — agent cannot distinguish them.
    // Param "q" (single character) has no description.
    {
      name: "search",
      description: "Search for things in the data store. Use this to look up items.",
      inputSchema: {
        type: "object" as const,
        properties: {
          q: { type: "string" },
        },
        required: ["q"],
      },
    },

    // ANTI-PATTERN: tool-selection-confusion + param-strictness
    // Overlaps entirely with "search". "type" param accepts undocumented values.
    {
      name: "find",
      description: "Find items in the system. Use this to search for content.",
      inputSchema: {
        type: "object" as const,
        properties: {
          query: { type: "string" },
          type: { type: "string" },
        },
        required: ["query"],
      },
    },

    // ANTI-PATTERN: namespacing + param-strictness + error-helpfulness
    // Name "change" is vague — should be "update_note".
    // "data" param format is completely ambiguous (JSON? key=value? free text?).
    // Errors are opaque.
    {
      name: "change",
      description: "Change something",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: { type: "string" },
          data: { type: "string" },
        },
        required: ["id", "data"],
      },
    },

    // ANTI-PATTERN: namespacing + error-helpfulness
    // "remove" is inconsistent with any prior naming ("delete" is the convention).
    // Errors give no information about what was not found.
    {
      name: "remove",
      description: "Remove",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: { type: "string" },
        },
        required: ["id"],
      },
    },
  ],
}));

// ---------------------------------------------------------------------------
// tools/call
// ---------------------------------------------------------------------------

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    // -----------------------------------------------------------------------
    // process — create note
    // -----------------------------------------------------------------------
    if (name === "process") {
      const data = (args?.data as string) ?? "";
      // "type" param silently ignored — undocumented behaviour
      const id = `note-${nextId++}`;
      // Ambiguous data format: try "title:content" split, fall back to whole string as content
      const colonIdx = data.indexOf(":");
      const title = colonIdx !== -1 ? data.slice(0, colonIdx).trim() : "Untitled";
      const content = colonIdx !== -1 ? data.slice(colonIdx + 1).trim() : data;

      notes[id] = {
        id,
        title,
        content,
        tags: "",
        created: new Date().toISOString().split("T")[0],
      };

      // ANTI-PATTERN: output-leanness — prose blob instead of structured JSON
      return {
        content: [
          {
            type: "text",
            text:
              `The operation has been completed successfully. A new item has been created ` +
              `and stored in the system. The unique identifier assigned to your newly created ` +
              `item is: ${id}. The title that was extracted from your data input is: ${title}. ` +
              `The content that was stored is: ${content}. The item has been saved and is now ` +
              `available for retrieval using the get operation with the identifier provided above.`,
          },
        ],
      };
    }

    // -----------------------------------------------------------------------
    // get — retrieve note by id
    // -----------------------------------------------------------------------
    if (name === "get") {
      const id = (args?.id as string) ?? "";
      const note = notes[id];

      if (!note) {
        // ANTI-PATTERN: error-helpfulness — no hint of what was not found or valid ID format
        return {
          content: [{ type: "text", text: "An error occurred." }],
          isError: true,
        };
      }

      // ANTI-PATTERN: output-leanness — prose blob instead of structured JSON
      return {
        content: [
          {
            type: "text",
            text:
              `Here is the item you requested. The identifier for this item is: ${note.id}. ` +
              `The title associated with this item is: ${note.title}. The content stored in ` +
              `this item is as follows: ${note.content}. The tags that have been associated ` +
              `with this item are: ${note.tags || "none"}. This item was created on the ` +
              `following date: ${note.created}. The above information represents the complete ` +
              `record for the requested item.`,
          },
        ],
      };
    }

    // -----------------------------------------------------------------------
    // search — search notes by title/content
    // -----------------------------------------------------------------------
    if (name === "search") {
      const q = (args?.q as string) ?? "";
      const lower = q.toLowerCase();
      const results = Object.values(notes).filter(
        (n) =>
          n.title.toLowerCase().includes(lower) ||
          n.content.toLowerCase().includes(lower)
      );

      if (results.length === 0) {
        // ANTI-PATTERN: output-leanness — explains the absence in verbose prose
        return {
          content: [
            {
              type: "text",
              text:
                `The search operation was performed using the query: "${q}". Unfortunately, ` +
                `the search did not return any results that match the provided search query. ` +
                `You may want to try a different search query or use different keywords.`,
            },
          ],
        };
      }

      // ANTI-PATTERN: output-leanness — prose list instead of a JSON array
      const resultText = results
        .map(
          (n) =>
            `Item identifier: ${n.id}, Title: ${n.title}, ` +
            `Content preview: ${n.content.substring(0, 60)}`
        )
        .join(". Next result: ");

      return {
        content: [
          {
            type: "text",
            text:
              `The search operation has completed. The following results were found for your ` +
              `search query "${q}": ${resultText}. A total of ${results.length} item(s) were ` +
              `found matching your search criteria.`,
          },
        ],
      };
    }

    // -----------------------------------------------------------------------
    // find — also searches notes (overlaps with search)
    // -----------------------------------------------------------------------
    if (name === "find") {
      const query = (args?.query as string) ?? "";
      // ANTI-PATTERN: "type" param accepted but has no documented values or effect
      const lower = query.toLowerCase();
      const results = Object.values(notes).filter(
        (n) =>
          n.title.toLowerCase().includes(lower) ||
          n.content.toLowerCase().includes(lower) ||
          n.tags.toLowerCase().includes(lower)
      );

      if (results.length === 0) {
        return {
          content: [{ type: "text", text: "No items found." }],
        };
      }

      // ANTI-PATTERN: output-leanness — unstructured multiline text
      const resultText = results
        .map((n) => `${n.id}: ${n.title} — ${n.content}`)
        .join("\n");

      return {
        content: [
          {
            type: "text",
            text: `Found ${results.length} result(s):\n${resultText}`,
          },
        ],
      };
    }

    // -----------------------------------------------------------------------
    // change — update note
    // -----------------------------------------------------------------------
    if (name === "change") {
      const id = (args?.id as string) ?? "";
      const data = (args?.data as string) ?? "";

      if (!notes[id]) {
        // ANTI-PATTERN: error-helpfulness — "Operation failed." with no context
        return {
          content: [{ type: "text", text: "Operation failed." }],
          isError: true,
        };
      }

      // ANTI-PATTERN: param-strictness — "data" format is undocumented;
      // try JSON patch, fall back to treating as raw content replacement
      try {
        const patch = JSON.parse(data) as Partial<Note>;
        Object.assign(notes[id], patch);
      } catch {
        notes[id].content = data;
      }

      // ANTI-PATTERN: output-leanness — verbose confirmation prose
      return {
        content: [
          {
            type: "text",
            text:
              `The change operation has been applied to the item with identifier: ${id}. ` +
              `The modifications you requested have been stored in the system. The item has ` +
              `been updated successfully and your changes are now reflected in the data store.`,
          },
        ],
      };
    }

    // -----------------------------------------------------------------------
    // remove — delete note
    // -----------------------------------------------------------------------
    if (name === "remove") {
      const id = (args?.id as string) ?? "";

      if (!notes[id]) {
        // ANTI-PATTERN: error-helpfulness — single character error with zero context
        return {
          content: [{ type: "text", text: "Error." }],
          isError: true,
        };
      }

      delete notes[id];

      // ANTI-PATTERN: output-leanness — verbose confirmation prose
      return {
        content: [
          {
            type: "text",
            text:
              `The remove operation has completed successfully. The item with the identifier ` +
              `you provided has been permanently deleted from the system and is no longer ` +
              `available for retrieval.`,
          },
        ],
      };
    }

    // ANTI-PATTERN: error-helpfulness — generic fallthrough with no tool name in message
    return {
      content: [{ type: "text", text: "Unknown operation." }],
      isError: true,
    };
  } catch {
    // ANTI-PATTERN: error-helpfulness — swallows all error details
    return {
      content: [{ type: "text", text: "An error occurred." }],
      isError: true,
    };
  }
});

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(() => process.exit(1));
