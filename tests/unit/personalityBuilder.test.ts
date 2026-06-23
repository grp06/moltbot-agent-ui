import { describe, expect, it } from "vitest";

import { WIDGET_PROMPT } from "@/features/agents/components/widgets/widgetPromptSnippet";
import { createAgentFilesState } from "@/lib/agents/agentFiles";
import {
  composeToolsContentWithWidgetPrompt,
  parsePersonalityFiles,
  serializePersonalityFiles,
  type PersonalityBuilderDraft,
} from "@/lib/agents/personalityBuilder";

const createFiles = () => createAgentFilesState();

describe("personalityBuilder", () => {
  it("parseIdentityMarkdown_extracts_fields_from_template_style_list", () => {
    const files = createFiles();
    files["IDENTITY.md"] = {
      exists: true,
      content: `# IDENTITY.md - Who Am I?\n\n- **Name:** Nova\n- **Creature:** fox spirit\n- **Vibe:** calm + direct\n- **Emoji:** 🦊\n- **Avatar:** avatars/nova.png\n`,
    };

    const draft = parsePersonalityFiles(files);

    expect(draft.identity).toEqual({
      name: "Nova",
      creature: "fox spirit",
      vibe: "calm + direct",
      emoji: "🦊",
      avatar: "avatars/nova.png",
    });
  });

  it("parseUserMarkdown_extracts_context_block_and_profile_fields", () => {
    const files = createFiles();
    files["USER.md"] = {
      exists: true,
      content: `# USER.md - About Your Human\n\n- **Name:** George\n- **What to call them:** GP\n- **Pronouns:** he/him\n- **Timezone:** America/Chicago\n- **Notes:** Building OpenClaw Studio.\n\n## Context\n\nWants concise technical answers.\nPrefers implementation over discussion.\n`,
    };

    const draft = parsePersonalityFiles(files);

    expect(draft.user).toEqual({
      name: "George",
      callThem: "GP",
      pronouns: "he/him",
      timezone: "America/Chicago",
      notes: "Building OpenClaw Studio.",
      context: "Wants concise technical answers.\nPrefers implementation over discussion.",
    });
  });

  it("parseSoulMarkdown_extracts_core_sections", () => {
    const files = createFiles();
    files["SOUL.md"] = {
      exists: true,
      content: `# SOUL.md - Who You Are\n\n## Core Truths\n\nBe direct.\nAvoid filler.\n\n## Boundaries\n\n- Keep user data private.\n\n## Vibe\n\nPragmatic and calm.\n\n## Continuity\n\nUpdate files when behavior changes.\n`,
    };

    const draft = parsePersonalityFiles(files);

    expect(draft.soul).toEqual({
      coreTruths: "Be direct.\nAvoid filler.",
      boundaries: "- Keep user data private.",
      vibe: "Pragmatic and calm.",
      continuity: "Update files when behavior changes.",
    });
  });

  it("ignores_template_placeholders_for_identity_and_user", () => {
    const files = createFiles();
    files["IDENTITY.md"] = {
      exists: true,
      content:
        "# IDENTITY.md - Who Am I?\n\n- **Name:** _(pick something you like)_\n- **Creature:** _(AI? robot? familiar? ghost in the machine? something weirder?)_\n- **Vibe:** _(how do you come across? sharp? warm? chaotic? calm?)_\n- **Emoji:** _(your signature — pick one that feels right)_\n- **Avatar:** _(workspace-relative path, http(s) URL, or data URI)_\n",
    };
    files["USER.md"] = {
      exists: true,
      content:
        "# USER.md - About Your Human\n\n- **Name:**\n- **What to call them:**\n- **Pronouns:** _(optional)_\n- **Timezone:**\n- **Notes:**\n\n## Context\n\n_(What do they care about? What projects are they working on? What annoys them? What makes them laugh? Build this over time.)_\n",
    };

    const draft = parsePersonalityFiles(files);

    expect(draft.identity).toEqual({
      name: "",
      creature: "",
      vibe: "",
      emoji: "",
      avatar: "",
    });
    expect(draft.user).toEqual({
      name: "",
      callThem: "",
      pronouns: "",
      timezone: "",
      notes: "",
      context: "",
    });
  });

  it("serializePersonalityFiles_emits_stable_markdown_for_identity_user_soul", () => {
    const draft: PersonalityBuilderDraft = {
      identity: {
        name: "Nova",
        creature: "fox spirit",
        vibe: "calm + direct",
        emoji: "🦊",
        avatar: "avatars/nova.png",
      },
      user: {
        name: "George",
        callThem: "GP",
        pronouns: "he/him",
        timezone: "America/Chicago",
        notes: "Building OpenClaw Studio.",
        context: "Wants concise technical answers.\nPrefers implementation over discussion.",
      },
      soul: {
        coreTruths: "Be direct.\nAvoid filler.",
        boundaries: "- Keep user data private.",
        vibe: "Pragmatic and calm.",
        continuity: "Update files when behavior changes.",
      },
      agents: "Top-level operating rules.",
      tools: "Tool conventions.",
      heartbeat: "Heartbeat notes.",
      memory: "Durable memory.",
    };

    const files = serializePersonalityFiles(draft);

    expect(files["IDENTITY.md"]).toBe(
      [
        "# IDENTITY.md - Who Am I?",
        "",
        "- Name: Nova",
        "- Creature: fox spirit",
        "- Vibe: calm + direct",
        "- Emoji: 🦊",
        "- Avatar: avatars/nova.png",
        "",
      ].join("\n")
    );

    expect(files["USER.md"]).toBe(
      [
        "# USER.md - About Your Human",
        "",
        "- Name: George",
        "- What to call them: GP",
        "- Pronouns: he/him",
        "- Timezone: America/Chicago",
        "- Notes: Building OpenClaw Studio.",
        "",
        "## Context",
        "",
        "Wants concise technical answers.",
        "Prefers implementation over discussion.",
        "",
      ].join("\n")
    );

    expect(files["SOUL.md"]).toBe(
      [
        "# SOUL.md - Who You Are",
        "",
        "## Core Truths",
        "",
        "Be direct.",
        "Avoid filler.",
        "",
        "## Boundaries",
        "",
        "- Keep user data private.",
        "",
        "## Vibe",
        "",
        "Pragmatic and calm.",
        "",
        "## Continuity",
        "",
        "Update files when behavior changes.",
        "",
      ].join("\n")
    );

    expect(files["AGENTS.md"]).toBe("Top-level operating rules.");
    expect(files["TOOLS.md"]).toBe(`Tool conventions.\n\n${WIDGET_PROMPT}`);
    expect(files["HEARTBEAT.md"]).toBe("Heartbeat notes.");
    expect(files["MEMORY.md"]).toBe("Durable memory.");
  });
});

describe("personalityBuilder WIDGET_PROMPT injection (PROMPT-02)", () => {
  it("appends WIDGET_PROMPT to TOOLS.md content when not already present", () => {
    const result = composeToolsContentWithWidgetPrompt("Existing tool guidance.");
    expect(result.startsWith("Existing tool guidance.")).toBe(true);
    expect(result.endsWith(WIDGET_PROMPT)).toBe(true);
    expect(result).toBe(`Existing tool guidance.\n\n${WIDGET_PROMPT}`);
  });

  it("returns input unchanged when WIDGET_PROMPT sentinel already present", () => {
    // The sentinel is the unique opening sentence of WIDGET_PROMPT — if the
    // stored TOOLS.md already contains it, the helper must not re-append.
    const existing = `Some tools.\n\n${WIDGET_PROMPT}`;
    const result = composeToolsContentWithWidgetPrompt(existing);
    expect(result).toBe(existing);
  });

  it("returns WIDGET_PROMPT alone when input is empty", () => {
    const result = composeToolsContentWithWidgetPrompt("");
    expect(result).toBe(WIDGET_PROMPT);
  });

  it("collapses a single trailing newline before the separator", () => {
    const result = composeToolsContentWithWidgetPrompt("trailing newline\n");
    expect(result).toBe(`trailing newline\n\n${WIDGET_PROMPT}`);
  });

  it("collapses multiple trailing newlines to the canonical separator", () => {
    const result = composeToolsContentWithWidgetPrompt("trailing\n\n\n");
    expect(result).toBe(`trailing\n\n${WIDGET_PROMPT}`);
  });

  it("serializePersonalityFiles emits TOOLS.md with WIDGET_PROMPT appended", () => {
    const draft: PersonalityBuilderDraft = {
      identity: { name: "", creature: "", vibe: "", emoji: "", avatar: "" },
      user: {
        name: "",
        callThem: "",
        pronouns: "",
        timezone: "",
        notes: "",
        context: "",
      },
      soul: { coreTruths: "", boundaries: "", vibe: "", continuity: "" },
      agents: "",
      tools: "Tool conventions.",
      heartbeat: "",
      memory: "",
    };

    const files = serializePersonalityFiles(draft);

    expect(files["TOOLS.md"]).toContain("Tool conventions.");
    expect(files["TOOLS.md"]).toContain(
      "You can render rich, sandboxed inline HTML in chat by emitting a <widget> tag.",
    );
    expect(files["TOOLS.md"]).toBe(`Tool conventions.\n\n${WIDGET_PROMPT}`);
  });

  it("serializePersonalityFiles is idempotent when draft.tools already contains the WIDGET_PROMPT sentinel", () => {
    const seeded = `Seeded text.\n\n${WIDGET_PROMPT}`;
    const draft: PersonalityBuilderDraft = {
      identity: { name: "", creature: "", vibe: "", emoji: "", avatar: "" },
      user: {
        name: "",
        callThem: "",
        pronouns: "",
        timezone: "",
        notes: "",
        context: "",
      },
      soul: { coreTruths: "", boundaries: "", vibe: "", continuity: "" },
      agents: "",
      tools: seeded,
      heartbeat: "",
      memory: "",
    };

    const files = serializePersonalityFiles(draft);

    expect(files["TOOLS.md"]).toBe(seeded);
    // Counting occurrences of the prompt sentinel: must remain exactly 1.
    const sentinel =
      "You can render rich, sandboxed inline HTML in chat by emitting a <widget> tag.";
    const occurrences = files["TOOLS.md"].split(sentinel).length - 1;
    expect(occurrences).toBe(1);
  });

  it("parsePersonalityFiles reads stored TOOLS.md content verbatim (D-04 storage stays clean)", () => {
    // The agent's stored TOOLS.md file does NOT contain the widget prompt —
    // only the composed wire output does. parsePersonalityFiles reads the
    // file content raw and must continue returning that raw content
    // untouched, so the editor UI shows the agent's clean tools file.
    const files = createAgentFilesState();
    files["TOOLS.md"] = { exists: true, content: "Stored tool docs without widgets." };

    const draft = parsePersonalityFiles(files);

    expect(draft.tools).toBe("Stored tool docs without widgets.");
    expect(draft.tools).not.toContain(
      "You can render rich, sandboxed inline HTML in chat by emitting a <widget> tag.",
    );
  });

  it("does not modify other AgentFileName fields on the serialize output", () => {
    const draft: PersonalityBuilderDraft = {
      identity: { name: "Nova", creature: "fox", vibe: "calm", emoji: "🦊", avatar: "" },
      user: {
        name: "GP",
        callThem: "GP",
        pronouns: "he/him",
        timezone: "UTC",
        notes: "",
        context: "",
      },
      soul: { coreTruths: "Be direct.", boundaries: "", vibe: "", continuity: "" },
      agents: "Top-level agents content.",
      tools: "Tool conventions.",
      heartbeat: "Heartbeat content.",
      memory: "Memory content.",
    };

    const files = serializePersonalityFiles(draft);

    expect(files["AGENTS.md"]).toBe("Top-level agents content.");
    expect(files["HEARTBEAT.md"]).toBe("Heartbeat content.");
    expect(files["MEMORY.md"]).toBe("Memory content.");
    // IDENTITY/SOUL/USER are formatted markdown — assert they do not contain
    // the widget prompt sentinel (the append must be confined to TOOLS.md alone).
    const widgetSentinel =
      "You can render rich, sandboxed inline HTML in chat by emitting a <widget> tag.";
    for (const fileName of ["IDENTITY.md", "USER.md", "SOUL.md", "AGENTS.md", "HEARTBEAT.md", "MEMORY.md"] as const) {
      expect(files[fileName]).not.toContain(widgetSentinel);
    }
  });
});
