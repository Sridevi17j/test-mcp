import express from "express";
import bodyParser from "body-parser";
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
          "User-Agent": "Mozilla/5.0 (compatible: MCPContentBot/1.0)"
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
// Fix: Use raw body parser instead
app.use(express.raw({
  type: 'application/json',
  limit: '10mb'
}));

const transports: { [sessionId: string]: SSEServerTransport } = {};

app.get("/sse", async (req, res) => {
  const transport = new SSEServerTransport("/messages", res);
  transports[transport.sessionId] = transport;
  console.log("SSE session started:", transport.sessionId);

  res.on("close", () => {
    console.log("SSE session closed:", transport.sessionId);
    delete transports[transport.sessionId];
  });

  await server.connect(transport);
});

// Fixed middleware function signature
app.post("/messages", async (req: express.Request, res: express.Response) => {
  const sessionId = req.query.sessionId as string;
  const transport = transports[sessionId];
  
  if (!transport) {
    return res.status(400).send("No transport found for sessionId");
  }

  try {
    // The request body is already available as a Buffer
    const bodyBuffer = req.body;
    const bodyStr = bodyBuffer.toString('utf8');
    
    try {
      const message = JSON.parse(bodyStr);
      
      // Just log the message to see its structure
      console.log("Received message type:", message.method);
      
      // Check if it's a tool call and extract the tool name
      if (message.method === "tools/call" && message.params && message.params.name) {
        const toolName = message.params.name;
        console.log("Tool call detected:", toolName);
      }
    } catch (parseError) {
      console.error("Error parsing JSON:", parseError);
      // Continue processing even if JSON parsing fails
    }
    
    // Process the original request
    await transport.handlePostMessage(req, res);
  } catch (error) {
    console.error("Error processing request:", error);
    res.status(500).send("Internal server error");
  }
});

const PORT = process.env.PORT || 3002;

app.listen(PORT, () => {
  console.log(`MCP Server running on port ${PORT}`);
});