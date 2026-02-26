interface ConversationTask {
  kind: "conversation";
  sessionId: string;
  messageIds: string[];
}

interface SubconsciousHooks {
  processConversationTask(task: ConversationTask): Promise<void>;
  consolidateCycle(): Promise<void>;
  decayCycle(): Promise<void>;
}

interface SubconsciousAgentOptions {
  queuePollIntervalMs: number;
  consolidateIntervalMs: number;
  decayIntervalMs: number;
}

export class SubconsciousAgent {
  private readonly queue: ConversationTask[] = [];
  private queueTimer: Timer | null = null;
  private consolidateTimer: Timer | null = null;
  private decayTimer: Timer | null = null;
  private processing = false;

  constructor(
    private readonly hooks: SubconsciousHooks,
    private readonly options: SubconsciousAgentOptions
  ) {}

  start(): void {
    if (!this.queueTimer) {
      this.queueTimer = setInterval(
        () => void this.workQueue(),
        this.options.queuePollIntervalMs
      );
    }

    if (!this.consolidateTimer) {
      this.consolidateTimer = setInterval(
        () => void this.hooks.consolidateCycle(),
        this.options.consolidateIntervalMs
      );
    }

    if (!this.decayTimer) {
      this.decayTimer = setInterval(
        () => void this.hooks.decayCycle(),
        this.options.decayIntervalMs
      );
    }
  }

  stop(): void {
    if (this.queueTimer) {
      clearInterval(this.queueTimer);
      this.queueTimer = null;
    }

    if (this.consolidateTimer) {
      clearInterval(this.consolidateTimer);
      this.consolidateTimer = null;
    }

    if (this.decayTimer) {
      clearInterval(this.decayTimer);
      this.decayTimer = null;
    }
  }

  enqueueConversation(sessionId: string, messageIds: string[]): void {
    if (messageIds.length === 0) {
      return;
    }

    this.queue.push({
      kind: "conversation",
      sessionId,
      messageIds
    });
  }

  getQueueDepth(): number {
    return this.queue.length;
  }

  async flush(): Promise<void> {
    while (this.queue.length > 0) {
      await this.workQueue();
    }
  }

  private async workQueue(): Promise<void> {
    if (this.processing) {
      return;
    }

    const task = this.queue.shift();
    if (!task) {
      return;
    }

    this.processing = true;
    try {
      await this.hooks.processConversationTask(task);
    } finally {
      this.processing = false;
    }
  }
}
