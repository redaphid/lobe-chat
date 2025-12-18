import { LobeChatPluginManifest } from '@lobehub/chat-plugin-sdk';
import { t } from 'i18next';
import { merge } from 'lodash-es';
import { StateCreator } from 'zustand/vanilla';

import { notification } from '@/components/AntdStaticMethods';
import { mcpService, PreConfiguredMcpServer } from '@/services/mcp';
import { pluginService } from '@/services/plugin';
import { toolService } from '@/services/tool';
import { pluginHelpers } from '@/store/tool/helpers';
import { LobeToolCustomPlugin, PluginInstallError } from '@/types/tool/plugin';
import { setNamespace } from '@/utils/storeDebug';

import { ToolStore } from '../../store';
import { pluginSelectors } from '../plugin/selectors';
import { defaultCustomPlugin } from './initialState';

const n = setNamespace('customPlugin');

// Track if pre-configured servers have been initialized
let preConfiguredServersInitialized = false;

export interface CustomPluginAction {
  initPreConfiguredMcpServers: () => Promise<void>;
  installCustomPlugin: (value: LobeToolCustomPlugin) => Promise<void>;
  reinstallCustomPlugin: (id: string) => Promise<void>;
  uninstallCustomPlugin: (id: string) => Promise<void>;
  updateCustomPlugin: (id: string, value: LobeToolCustomPlugin) => Promise<void>;
  updateNewCustomPlugin: (value: Partial<LobeToolCustomPlugin>) => void;
}

/**
 * Convert a pre-configured MCP server to LobeToolCustomPlugin format
 */
const convertToCustomPlugin = (server: PreConfiguredMcpServer): LobeToolCustomPlugin => {
  if (server.type === 'http') {
    return {
      customParams: {
        mcp: {
          auth: server.auth,
          headers: server.headers,
          type: 'http',
          url: server.url,
        },
      },
      identifier: server.identifier,
      type: 'customPlugin',
    };
  } else {
    return {
      customParams: {
        mcp: {
          args: server.args,
          command: server.command,
          env: server.env,
          type: 'stdio',
        },
      },
      identifier: server.identifier,
      type: 'customPlugin',
    };
  }
};

export const createCustomPluginSlice: StateCreator<
  ToolStore,
  [['zustand/devtools', never]],
  [],
  CustomPluginAction
> = (set, get) => ({
  /**
   * Initialize pre-configured MCP servers from the mounted config file.
   * This should be called on app startup to auto-install servers.
   */
  initPreConfiguredMcpServers: async () => {
    // Only initialize once per session
    if (preConfiguredServersInitialized) return;
    preConfiguredServersInitialized = true;

    try {
      const preConfiguredServers = await mcpService.getPreConfiguredServers();

      if (preConfiguredServers.length === 0) return;

      console.log(
        `[MCP Config] Found ${preConfiguredServers.length} pre-configured MCP servers`,
      );

      const { installCustomPlugin, refreshPlugins } = get();

      // Get currently installed plugins
      const installedPlugins = pluginSelectors.installedPlugins(get());
      const installedIds = new Set(installedPlugins.map((p) => p.identifier));

      // Install any servers that aren't already installed
      for (const server of preConfiguredServers) {
        if (!installedIds.has(server.identifier)) {
          console.log(`[MCP Config] Auto-installing MCP server: ${server.identifier}`);
          const plugin = convertToCustomPlugin(server);
          await installCustomPlugin(plugin);
        } else {
          console.log(`[MCP Config] MCP server already installed: ${server.identifier}`);
        }
      }

      await refreshPlugins();
    } catch (error) {
      console.error('[MCP Config] Failed to initialize pre-configured MCP servers:', error);
    }
  },

  installCustomPlugin: async (value) => {
    await pluginService.createCustomPlugin(value);

    await get().refreshPlugins();
    set({ newCustomPlugin: defaultCustomPlugin }, false, n('saveToCustomPluginList'));
  },
  reinstallCustomPlugin: async (id) => {
    const plugin = pluginSelectors.getCustomPluginById(id)(get());
    if (!plugin) return;

    const { refreshPlugins, updateInstallLoadingState } = get();

    try {
      updateInstallLoadingState(id, true);
      let manifest: LobeChatPluginManifest;
      // mean this is a mcp plugin
      if (!!plugin.customParams?.mcp) {
        const url = plugin.customParams?.mcp?.url;
        if (!url) return;

        manifest = await mcpService.getStreamableMcpServerManifest({
          auth: plugin.customParams.mcp.auth,
          headers: plugin.customParams.mcp.headers,
          identifier: plugin.identifier,
          metadata: {
            avatar: plugin.customParams.avatar,
            description: plugin.customParams.description,
          },
          url,
        });
      } else {
        manifest = await toolService.getToolManifest(
          plugin.customParams?.manifestUrl,
          plugin.customParams?.useProxy,
        );
      }
      updateInstallLoadingState(id, false);

      await pluginService.updatePluginManifest(id, manifest);
      await refreshPlugins();
    } catch (error) {
      updateInstallLoadingState(id, false);

      console.error(error);
      const err = error as PluginInstallError;

      const meta = pluginSelectors.getPluginMetaById(id)(get());
      const name = pluginHelpers.getPluginTitle(meta);

      notification.error({
        description: t(`error.${err.message}`, { error: err.cause, ns: 'plugin' }),
        message: t('error.reinstallError', { name, ns: 'plugin' }),
      });
    }
  },
  uninstallCustomPlugin: async (id) => {
    await pluginService.uninstallPlugin(id);
    await get().refreshPlugins();
  },

  updateCustomPlugin: async (id, value) => {
    const { reinstallCustomPlugin } = get();
    // 1. 更新 list 项信息
    await pluginService.updatePlugin(id, value);

    // 2. 重新安装插件
    await reinstallCustomPlugin(id);
  },
  updateNewCustomPlugin: (newCustomPlugin) => {
    set(
      { newCustomPlugin: merge({}, get().newCustomPlugin, newCustomPlugin) },
      false,
      n('updateNewDevPlugin'),
    );
  },
});
