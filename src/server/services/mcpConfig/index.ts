import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import debug from 'debug';

const log = debug('lobe-mcp:config');

/**
 * MCP Server configuration following Claude Code's .mcp.json format
 */
export interface McpServerConfig {
  args?: string[];
  command?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  type: 'http' | 'stdio' | 'sse';
  url?: string;
}

export interface McpConfigFile {
  mcpServers: Record<string, McpServerConfig>;
}

/**
 * Parsed MCP server ready for LobeChat
 */
export interface ParsedMcpServer {
  auth?: {
    token?: string;
    type: 'none' | 'bearer';
  };
  headers?: Record<string, string>;
  identifier: string;
  type: 'http' | 'stdio';
  // stdio fields
  args?: string[];
  command?: string;
  env?: Record<string, string>;
  // http fields
  url?: string;
}

// Default config file paths to check
const CONFIG_PATHS = [
  '/app/config/mcp.json', // Docker mount point
  '/app/mcp.json',
  join(process.cwd(), 'mcp.json'),
  join(process.cwd(), '.mcp.json'),
];

// Environment variable to override config path
const CONFIG_PATH_ENV = process.env.MCP_CONFIG_PATH;

let cachedConfig: ParsedMcpServer[] | null = null;

/**
 * Expand environment variables in strings
 * Supports ${VAR} and ${VAR:-default} syntax
 */
function expandEnvVars(value: string): string {
  return value.replace(/\$\{(\w+)(?::-([^}]*))?\}/g, (_, varName, defaultValue) => {
    return process.env[varName] ?? defaultValue ?? '';
  });
}

/**
 * Recursively expand environment variables in an object
 */
function expandEnvVarsInObject<T>(obj: T): T {
  if (typeof obj === 'string') {
    return expandEnvVars(obj) as T;
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => expandEnvVarsInObject(item)) as T;
  }
  if (obj && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = expandEnvVarsInObject(value);
    }
    return result as T;
  }
  return obj;
}

/**
 * Load and parse the MCP config file
 */
export function loadMcpConfig(): ParsedMcpServer[] {
  if (cachedConfig !== null) {
    return cachedConfig;
  }

  const pathsToCheck = CONFIG_PATH_ENV ? [CONFIG_PATH_ENV, ...CONFIG_PATHS] : CONFIG_PATHS;

  for (const configPath of pathsToCheck) {
    if (existsSync(configPath)) {
      try {
        log('Loading MCP config from: %s', configPath);
        const content = readFileSync(configPath, 'utf-8');
        const config = JSON.parse(content) as McpConfigFile;

        if (!config.mcpServers || typeof config.mcpServers !== 'object') {
          log('Invalid MCP config: missing mcpServers object');
          continue;
        }

        const servers: ParsedMcpServer[] = [];

        for (const [identifier, serverConfig] of Object.entries(config.mcpServers)) {
          const expandedConfig = expandEnvVarsInObject(serverConfig);

          // Map Claude Code format to LobeChat format
          if (expandedConfig.type === 'http' || expandedConfig.url) {
            servers.push({
              auth: expandedConfig.headers?.Authorization
                ? {
                    token: expandedConfig.headers.Authorization.replace(/^Bearer\s+/i, ''),
                    type: 'bearer',
                  }
                : { type: 'none' },
              headers: expandedConfig.headers,
              identifier,
              type: 'http',
              url: expandedConfig.url,
            });
          } else if (expandedConfig.type === 'stdio' || expandedConfig.command) {
            servers.push({
              args: expandedConfig.args || [],
              command: expandedConfig.command!,
              env: expandedConfig.env,
              identifier,
              type: 'stdio',
            });
          } else {
            log('Skipping invalid server config for %s: missing url or command', identifier);
          }
        }

        log('Loaded %d MCP servers from config', servers.length);
        cachedConfig = servers;
        return servers;
      } catch (error) {
        log('Error loading MCP config from %s: %O', configPath, error);
      }
    }
  }

  log('No MCP config file found');
  cachedConfig = [];
  return [];
}

/**
 * Clear the cached config (useful for testing or hot-reload)
 */
export function clearMcpConfigCache(): void {
  cachedConfig = null;
}

/**
 * Get pre-configured MCP servers
 */
export function getPreConfiguredMcpServers(): ParsedMcpServer[] {
  return loadMcpConfig();
}
