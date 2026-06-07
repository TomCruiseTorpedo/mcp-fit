/**
 * Strawman-FIXED MCP server — the strawman done right.
 *
 * Same in-memory note-store domain as fixtures/strawman-server, but with
 * agent-friendly contracts on the axes static lint can assess:
 *
 *   namespacing       — clear, domain-prefixed tool names (note_*), each with a
 *                       description that states what the tool does.
 *   param-strictness  — every parameter has a description; required vs optional
 *                       is explicit; an enum is used where values are bounded.
 *
 * Pair with strawman-server to show a keyless red→green deterministic lint
 * delta (no API key): `mcp-fit scan` the strawman, then this, and compare the
 * LINT SCORE. (output-leanness / error-helpfulness / tool-selection-confusion
 * are eval-only axes — measured via `--eval`, not the deterministic badge.)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// ---------------------------------------------------------------------------
// In-memory note store — seeded so tasks can start immediately
// ---------------------------------------------------------------------------

interface Note {
  id: string;
  title: string;
  content: string;
  tags: string[];
  created: string;
}

const notes: Record<string, Note> = {
  "note-1": {
    id: "note-1",
    title: "Introduction",
    content: "Welcome to the system. This note introduces the workspace.",
    tags: ["intro", "welcome"],
    created: "2026-01-01",
  },
  "note-2": {
    id: "note-2",
    title: "Meeting",
    content: "Q1 review scheduled for next week. Bring the numbers.",
    tags: ["meeting", "q1"],
    created: "2026-01-15",
  },
};

let nextId = 3;

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = new Server(
  { name: "strawman-fixed", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "note_create",
      description:
        "Create a new note in the store and return its assigned ID. Use this when the user wants to save new content.",
      inputSchema: {
        type: "object" as const,
        properties: {
          title: {
            type: "string",
            description: "Short human-readable title for the note.",
          },
          content: {
            type: "string",
            description: "The note body text.",
          },
          tags: {
            type: "array",
            items: { type: "string" },
            description: "Optional list of tags, e.g. ['work', 'urgent'].",
          },
        },
        required: ["title", "content"],
      },
    },
    {
      name: "note_get",
      description: "Retrieve a single note by its unique ID.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: {
            type: "string",
            description: "The note's unique identifier, e.g. 'note-1'.",
          },
        },
        required: ["id"],
      },
    },
    {
      name: "note_search",
      description:
        "Full-text search across note titles and content. Returns every note whose title or body contains the query. Use note_list to enumerate by tag instead.",
      inputSchema: {
        type: "object" as const,
        properties: {
          query: {
            type: "string",
            description: "Search terms matched against note title and content.",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "note_list",
      description:
        "List notes, optionally filtered by a single tag. Use note_search for free-text matching instead.",
      inputSchema: {
        type: "object" as const,
        properties: {
          tag: {
            type: "string",
            description: "Optional tag to filter by; omit to list all notes.",
          },
          sort: {
            type: "string",
            enum: ["created_asc", "created_desc"],
            description: "Order results by creation date. Defaults to created_desc.",
          },
        },
        required: [],
      },
    },
    {
      name: "note_update",
      description:
        "Update the title and/or content of an existing note identified by ID. Omitted fields are left unchanged.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: {
            type: "string",
            description: "The unique identifier of the note to update.",
          },
          title: {
            type: "string",
            description: "New title; omit to leave the title unchanged.",
          },
          content: {
            type: "string",
            description: "New body text; omit to leave the content unchanged.",
          },
        },
        required: ["id"],
      },
    },
    {
      name: "note_delete",
      description: "Delete a note by its unique ID. Returns whether a note was removed.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: {
            type: "string",
            description: "The unique identifier of the note to delete.",
          },
        },
        required: ["id"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const json = (value: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
  });

  switch (name) {
    case "note_create": {
      const id = `note-${nextId++}`;
      notes[id] = {
        id,
        title: String(args?.title ?? ""),
        content: String(args?.content ?? ""),
        tags: Array.isArray(args?.tags) ? (args!.tags as string[]) : [],
        created: "2026-02-01",
      };
      return json(notes[id]);
    }
    case "note_get": {
      const note = notes[String(args?.id)];
      if (!note) return json({ error: `No note found with id '${String(args?.id)}'.` });
      return json(note);
    }
    case "note_search": {
      const q = String(args?.query ?? "").toLowerCase();
      const hits = Object.values(notes).filter(
        (n) => n.title.toLowerCase().includes(q) || n.content.toLowerCase().includes(q)
      );
      return json(hits);
    }
    case "note_list": {
      const tag = args?.tag ? String(args.tag) : null;
      let result = Object.values(notes);
      if (tag) result = result.filter((n) => n.tags.includes(tag));
      const desc = args?.sort !== "created_asc";
      result = [...result].sort((a, b) =>
        desc ? b.created.localeCompare(a.created) : a.created.localeCompare(b.created)
      );
      return json(result);
    }
    case "note_update": {
      const note = notes[String(args?.id)];
      if (!note) return json({ error: `No note found with id '${String(args?.id)}'.` });
      if (args?.title !== undefined) note.title = String(args.title);
      if (args?.content !== undefined) note.content = String(args.content);
      return json(note);
    }
    case "note_delete": {
      const id = String(args?.id);
      const existed = id in notes;
      delete notes[id];
      return json({ deleted: existed, id });
    }
    default:
      return json({ error: `Unknown tool '${String(name)}'.` });
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
