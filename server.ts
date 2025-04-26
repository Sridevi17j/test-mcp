import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";
import axios from "axios";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";

// Create an MCP server
const server = new McpServer({
  name: "web-content-extractor",
  version: "1.0.0"
});

// Tool: extract-url using Readability + jsdom
server.tool(
  "extract-url",
  { url: z.string().url() },
  async ({ url }) => {
    console.log(`Extracting readable content from: ${url}`);
    try {
      const response = await axios.get(url, {
        timeout: 10000,
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; MCPContentBot/1.0)"
        }
      });

      const dom = new JSDOM(response.data, { url });
      const reader = new Readability(dom.window.document);
      const article = reader.parse();

      if (article?.textContent) {
        return {
          content: [{ type: "text", text: article.textContent }]
        };
      } else {
        return {
          content: [{ type: "text", text: "Could not extract readable content from the page." }]
        };
      }
    } catch (err: any) {
      console.error("Extraction failed:", err.message || err);
      return {
        content: [{ type: "text", text: `Failed to extract content: ${err.message}` }]
      };
    }
  }
);

// Express + SSE setup
const app = express();
const transports: { [sessionId: string]: SSEServerTransport } = {};

app.get("/sse", (req, res) => {
  const transport = new SSEServerTransport("/messages", res);
  transports[transport.sessionId] = transport;
  console.log("SSE session started:", transport.sessionId);

  res.on("close", () => {
    console.log("SSE session closed:", transport.sessionId);
    delete transports[transport.sessionId];
  });

  server.connect(transport);
});

// Simple middleware to log request data
app.use(express.text({ type: "*/*" }));

app.post("/messages", (req, res) => {
  const sessionId = req.query.sessionId as string;
  const transport = transports[sessionId];
  
  if (!transport) {
    return res.status(400).send("No transport found for sessionId");
  }

  // Log the raw request body for inspection
  console.log("Raw request body:", req.body);
  
  try {
    // Try to parse as JSON to extract tool name
    const message = JSON.parse(req.body as string);
    if (message.method === "tools/call" && message.params && message.params.name) {
      console.log("TOOL CALL DETECTED:", message.params.name);
      console.log("Arguments:", JSON.stringify(message.params.arguments));
    }
  } catch (e) {
    console.log("Not a valid JSON or not a tool call");
  }
  
  // Create a new request to pass to handlePostMessage
  const rawBody = Buffer.from(req.body as string);
  const newReq = Object.create(req);
  newReq.body = rawBody;
  
  // Continue with normal processing
  transport.handlePostMessage(newReq, res);
});

const PORT = process.env.PORT || 3002;

app.listen(PORT, () => {
  console.log(`MCP Server running on port ${PORT}`);
});