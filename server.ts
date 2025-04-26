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
app.use(bodyParser.json());

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

// Modified messages endpoint to extract tool name
app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId as string;
  const transport = transports[sessionId];
  
  if (!transport) {
    return res.status(400).send("No transport found for sessionId");
  }

  const chunks: Buffer[] = [];
  
  req.on('data', (chunk) => {
    chunks.push(Buffer.from(chunk));
  });
  
  req.on('end', async () => {
    try {
      const bodyBuffer = Buffer.concat(chunks);
      const bodyStr = bodyBuffer.toString('utf8');
      const message = JSON.parse(bodyStr);
      
      // Just log the message to see its structure
      console.log("Received message type:", message.method);
      
      // Check if it's a tool call and extract the tool name
      if (message.method === "tools/call" && message.params && message.params.name) {
        const toolName = message.params.name;
        console.log("Tool call detected:", toolName);
      }
      
      // Create a new request with the original body
      const newReq = Object.create(req);
      newReq.body = bodyBuffer;
      
      // Process the request
      await transport.handlePostMessage(newReq, res);
    } catch (error) {
      console.error("Error processing request:", error);
      res.status(500).send("Internal server error");
    }
  });
});

const PORT = process.env.PORT || 3002;

app.listen(PORT, () => {
  console.log(`MCP Server running on port ${PORT}`);
});