// server.ts
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

// 📝 Prompt: summarize-content
server.registerPrompt(
  "summarize-content",
  {
    title: "Summarize Web Content",
    description: "Analyze and summarize extracted web content",
    argsSchema: { 
      content: z.string().describe("The web content to summarize"),
      focus: z.string().optional().describe("Specific aspect to focus on (optional)")
    }
  },
  ({ content, focus }) => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: focus 
          ? `Please summarize this web content focusing on ${focus}:\n\n${content}`
          : `Please provide a clear summary of this web content:\n\n${content}`
      }
    }]
  })
);

// 🛠️ Tool: extract-url using Readability + jsdom
server.tool(
  "extract-url",
  { url: z.string().url() },
  async ({ url }) => {
    console.log(`🔍 Extracting readable content from: ${url}`);
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

// Create a custom transport class that logs tool calls
class LoggingSSEServerTransport extends SSEServerTransport {
  async handlePostMessage(req: any, res: any) {
    // Try to get the raw body to check for tool calls
    const bodyData: any[] = [];
    
    req.on('data', (chunk: any) => {
      bodyData.push(chunk);
    });
    
    req.on('end', () => {
      try {
        const bodyBuffer = Buffer.concat(bodyData);
        const bodyStr = bodyBuffer.toString('utf8');
        const message = JSON.parse(bodyStr);
        
        if (message.method === "tools/call" && message.params && message.params.name) {
          console.log("🔧 Tool call detected:", message.params.name);
        }
      } catch (e) {
        // Ignore parsing errors
      }
    });
    
    // Call the parent method to handle the message normally
    return super.handlePostMessage(req, res);
  }
}

app.get("/sse", async (req, res) => {
  // Use our custom transport instead of the standard one
  const transport = new LoggingSSEServerTransport("/messages", res);
  transports[transport.sessionId] = transport;
  console.log("🔗 SSE session started:", transport.sessionId);
  res.on("close", () => {
    console.log("SSE session closed:", transport.sessionId);
    delete transports[transport.sessionId];
  });
  await server.connect(transport);
});

app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId as string;
  const transport = transports[sessionId];
  if (transport) {
    await transport.handlePostMessage(req, res);
  } else {
    res.status(400).send("No transport found for sessionId");
  }
});

const PORT = process.env.PORT || 3002;
app.listen(PORT, () => {
  console.log(` MCP Server running on port ${PORT}`);
});
