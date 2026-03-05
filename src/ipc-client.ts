/**
 * ipc-client.ts — Whazaa-flavoured WatcherClient.
 *
 * Wraps AIBroker's WatcherClient (which requires a socket path), pins it to
 * the Whazaa socket, and provides typed result interfaces for MCP tool code.
 */

import { WatcherClient as AIBrokerClient } from "aibroker";

// ---------------------------------------------------------------------------
// Socket path — used by both client (here) and server (ipc-server.ts)
// ---------------------------------------------------------------------------

export const IPC_SOCKET_PATH = "/tmp/whazaa-watcher.sock";

// ---------------------------------------------------------------------------
// Result types (mirrors watcher handler return shapes)
// ---------------------------------------------------------------------------

export interface StatusResult {
  connected: boolean;
  phoneNumber: string | null;
  awaitingQR: boolean;
}

export interface SendResult {
  preview: string;
  targetJid?: string;
}

export interface ReceiveResult {
  messages: Array<{ body: string; timestamp: number }>;
}

export interface WaitResult {
  messages: Array<{ body: string; timestamp: number }>;
}

export interface ContactEntry {
  jid: string;
  name: string | null;
  phoneNumber: string;
  lastSeen: number;
}

export interface ContactsResult {
  contacts: ContactEntry[];
}

export interface LoginResult {
  message: string;
}

export interface RegisterResult {
  registered: boolean;
}

export interface RenameResult {
  success: boolean;
  name?: string;
  error?: string;
}

export interface ChatEntry {
  jid: string;
  name: string;
  lastMessageTimestamp: number;
  unreadCount: number;
}

export interface ChatsResult {
  chats: ChatEntry[];
}

export interface HistoryMessage {
  id: string | null;
  fromMe: boolean;
  timestamp: number;
  date: string;
  text: string;
  type: string;
}

export interface HistoryResult {
  messages: HistoryMessage[];
  count: number;
}

export interface TtsResult {
  targetJid: string;
  voice: string;
  bytesSent: number;
  chunks?: number;
}

export interface VoiceConfigResult {
  success: boolean;
  config?: {
    defaultVoice: string;
    voiceMode: boolean;
    localMode: boolean;
    personas: Record<string, string>;
  };
  error?: string;
}

export interface SpeakResult {
  success: boolean;
  voice?: string;
  error?: string;
}

export interface SendFileResult {
  fileName: string;
  fileSize: number;
  targetJid: string;
}

export interface DiscoverResult {
  alive: string[];
  pruned: string[];
  discovered: string[];
}

export interface SessionListResult {
  sessions: Array<{ index: number; name: string; type: string; active: boolean }>;
}

export interface SwitchResult {
  switched: boolean;
  name: string;
}

export interface EndSessionResult {
  ended: boolean;
  name: string;
}

export interface CommandResult {
  executed: boolean;
  command: string;
}

export interface DictateResult {
  transcript: string;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class WatcherClient {
  private readonly client: AIBrokerClient;

  constructor() {
    this.client = new AIBrokerClient(IPC_SOCKET_PATH);
  }

  get session(): string {
    return this.client.session;
  }

  async register(name?: string): Promise<RegisterResult> {
    return this.client.register(name) as Promise<unknown> as Promise<RegisterResult>;
  }

  async rename(name: string): Promise<RenameResult> {
    return this.client.rename(name) as Promise<unknown> as Promise<RenameResult>;
  }

  async status(): Promise<StatusResult> {
    return this.client.status() as Promise<unknown> as Promise<StatusResult>;
  }

  async send(message: string, recipient?: string, channel?: string): Promise<SendResult> {
    return this.client.send(message, recipient, channel) as Promise<unknown> as Promise<SendResult>;
  }

  async receive(from?: string): Promise<ReceiveResult> {
    return this.client.receive(from) as Promise<unknown> as Promise<ReceiveResult>;
  }

  async contacts(search?: string, limit?: number): Promise<ContactsResult> {
    return this.client.contacts(search, limit) as Promise<unknown> as Promise<ContactsResult>;
  }

  async chats(params?: { search?: string; limit?: number }): Promise<ChatsResult> {
    return this.client.chats(params?.search, params?.limit) as Promise<unknown> as Promise<ChatsResult>;
  }

  async wait(timeoutMs: number): Promise<WaitResult> {
    return this.client.wait(timeoutMs) as Promise<unknown> as Promise<WaitResult>;
  }

  async login(): Promise<LoginResult> {
    return this.client.login() as Promise<unknown> as Promise<LoginResult>;
  }

  async history(params: { jid: string; count?: number }): Promise<HistoryResult> {
    return this.client.history(params) as Promise<unknown> as Promise<HistoryResult>;
  }

  async tts(params: { text: string; voice?: string; jid?: string; channel?: string }): Promise<TtsResult> {
    return this.client.tts(params) as Promise<unknown> as Promise<TtsResult>;
  }

  async voiceConfig(action: "get" | "set", updates?: Record<string, unknown>): Promise<VoiceConfigResult> {
    return this.client.voiceConfig(action, updates) as Promise<unknown> as Promise<VoiceConfigResult>;
  }

  async sendFile(filePath: string, recipient?: string, caption?: string, prettify?: boolean): Promise<SendFileResult> {
    return this.client.sendFile(filePath, recipient, caption, prettify) as Promise<unknown> as Promise<SendFileResult>;
  }

  async speak(text: string, voice?: string): Promise<SpeakResult> {
    return this.client.speak(text, voice) as Promise<unknown> as Promise<SpeakResult>;
  }

  async discover(): Promise<DiscoverResult> {
    return this.client.discover() as Promise<unknown> as Promise<DiscoverResult>;
  }

  async sessions(): Promise<SessionListResult> {
    return this.client.sessions() as Promise<unknown> as Promise<SessionListResult>;
  }

  async switchSession(target: string): Promise<SwitchResult> {
    return this.client.switchSession(target) as Promise<unknown> as Promise<SwitchResult>;
  }

  async endSession(target: string): Promise<EndSessionResult> {
    return this.client.endSession(target) as Promise<unknown> as Promise<EndSessionResult>;
  }

  async command(text: string): Promise<CommandResult> {
    return this.client.command(text) as Promise<unknown> as Promise<CommandResult>;
  }

  async dictate(maxDuration?: number): Promise<DictateResult> {
    return this.client.dictate(maxDuration) as Promise<unknown> as Promise<DictateResult>;
  }

  async broadcastStatus(status: string): Promise<{ status: string }> {
    return this.client.broadcastStatus(status) as Promise<unknown> as Promise<{ status: string }>;
  }
}
