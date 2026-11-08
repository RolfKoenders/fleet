import { CLAUDE_JSON } from "./mcp.ts";
import { SETTINGS_FILE } from "./settings.ts";
import type { Tool } from "./settings.ts";

/**
 * Where each agent finds what it loads before the first prompt, written once. Paths are in `~/` form.
 * `fleet context` measures exactly these, so a location an agent starts to read belongs here.
 */
export type AgentLocations = {
  /** Instruction files read as they are. */
  instructionFiles: string[];
  /** Directories whose `*.md` files, at any depth, are instructions too. */
  instructionDirs: string[];
  /** The file whose `instructions` list names more instruction files, or null. */
  instructionsSetting: string | null;
  /** Directories of skills, lowest precedence first. */
  skillDirs: string[];
  /** The file whose `skills` list names more skill directories, or null. */
  skillsSetting: string | null;
  /** The file holding the MCP servers, and the key their names are under. */
  mcp: { file: string; key: string };
};

export const AGENT_LOCATIONS: Record<Tool, AgentLocations> = {
  claude: {
    instructionFiles: ["~/.claude/CLAUDE.md"],
    instructionDirs: ["~/.claude/rules"],
    instructionsSetting: null,
    skillDirs: ["~/.claude/skills"],
    skillsSetting: null,
    mcp: { file: CLAUDE_JSON, key: "mcpServers" },
  },
  // opencode reads Claude's skill directory as well as its own (https://opencode.ai/docs/skills), and a skill
  // of the same name in a later directory replaces the earlier one.
  opencode: {
    instructionFiles: ["~/.config/opencode/AGENTS.md"],
    instructionDirs: [],
    instructionsSetting: SETTINGS_FILE.opencode,
    skillDirs: ["~/.claude/skills", "~/.agents/skills", "~/.config/opencode/skills"],
    skillsSetting: SETTINGS_FILE.opencode,
    mcp: { file: SETTINGS_FILE.opencode, key: "mcp" },
  },
};
