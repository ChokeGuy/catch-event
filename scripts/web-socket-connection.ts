import { Listener, ProviderEvent, WebSocketProvider } from "ethers";
import { WebSocket } from "ws"; // Correct way to import WebSocket

const EXPECTED_PONG_BACK = 15000;
const KEEP_ALIVE_CHECK_INTERVAL = 60 * 1000;
const MAX_RECONNECTION_ATTEMPTS = 10;
const RECONNECTION_DELAY = 5000; // 5 seconds
const EVENT_POLL_INTERVAL = 60 * 1000; // 1 minute

const debug = (message: string) => {
  console.debug(message);
};

interface Subscription {
  type: ProviderEvent;
  listener: Listener;
}

class ResilientWebsocketProvider {
  private readonly url: string;
  private readonly chainId: number;
  private terminate: boolean;
  private pingTimeout: NodeJS.Timeout | null;
  private keepAliveInterval: NodeJS.Timeout | null;
  private eventPollInterval: NodeJS.Timeout | null;
  private ws: WebSocket | null;
  private provider: WebSocketProvider | null;
  readonly subscriptions: Set<Subscription>;
  private reconnectionAttempts: number;
  private isConnected: boolean;
  private lastProcessedBlock: number;

  constructor(url: string, chainId: number) {
    this.url = url;
    this.chainId = chainId;
    this.terminate = false;
    this.pingTimeout = null;
    this.keepAliveInterval = null;
    this.eventPollInterval = null;
    this.ws = null;
    this.provider = null;
    this.subscriptions = new Set();
    this.reconnectionAttempts = 0;
    this.isConnected = false;
    this.lastProcessedBlock = 0;
  }

  async connect(): Promise<WebSocketProvider | null> {
    return new Promise((resolve) => {
      const startConnection = () => {
        if (this.reconnectionAttempts >= MAX_RECONNECTION_ATTEMPTS) {
          console.error(
            `Max reconnection attempts (${MAX_RECONNECTION_ATTEMPTS}) reached for ${this.url}. Stopping reconnection.`
          );
          this.terminate = true;
          resolve(null);
          return;
        }

        this.ws = new WebSocket(this.url);

        this.ws.on("open", async () => {
          this.reconnectionAttempts = 0;
          this.isConnected = true;
          this.setupKeepAlive();
          this.setupEventPolling();

          try {
            const wsp = new WebSocketProvider(
              () => this.ws as WebSocket,
              this.chainId
            );

            while (this.ws?.readyState !== WebSocket.OPEN) {
              debug("Waiting for websocket to be open");
              await this.sleep(1000);
            }

            wsp._start();

            while (!wsp.ready) {
              debug("Waiting for websocket provider to be ready");
              await this.sleep(1000);
            }

            this.provider = wsp;
            await this.resubscribe();
            resolve(this.provider);
          } catch (error) {
            console.error(
              `Error initializing WebSocketProvider for ${this.url}:`,
              error
            );
            this.cleanupConnection();
            this.reconnectionAttempts++;
            setTimeout(startConnection, RECONNECTION_DELAY);
          }
        });

        this.ws.on("close", () => {
          console.error(`The websocket connection was closed for ${this.url}`);
          this.isConnected = false;
          this.cleanupConnection();
          if (!this.terminate) {
            this.reconnectionAttempts++;
            debug(
              `Attempting to reconnect... (Attempt ${this.reconnectionAttempts})`
            );
            setTimeout(startConnection, RECONNECTION_DELAY);
          }
        });

        this.ws.on("error", (error) => {
          console.error(`WebSocket error for ${this.url}:`, error);
        });

        this.ws.on("pong", () => {
          debug("Received pong, so connection is alive, clearing the timeout");
          if (this.pingTimeout) clearTimeout(this.pingTimeout);
        });
      };

      startConnection();
    });
  }

  private setupKeepAlive() {
    this.keepAliveInterval = setInterval(() => {
      if (!this.ws) {
        debug("No websocket, exiting keep alive interval");
        return;
      }
      debug("Checking if the connection is alive, sending a ping");

      this.ws.ping();

      this.pingTimeout = setTimeout(() => {
        if (this.ws) this.ws.terminate();
      }, EXPECTED_PONG_BACK);
    }, KEEP_ALIVE_CHECK_INTERVAL);
  }

  private setupEventPolling() {
    this.eventPollInterval = setInterval(async () => {
      if (this.provider) {
        await this.pollEvents();
      }
    }, EVENT_POLL_INTERVAL);
  }

  private async pollEvents() {
    const currentBlock = await this.provider!.getBlockNumber();
    for (const subscription of this.subscriptions) {
      try {
        // Handle different types of subscriptions
        if (subscription.type === "block") {
          // For block events, just update the last processed block
          this.lastProcessedBlock = currentBlock;
          continue;
        }

        // For contract events (assuming the type is a contract address)
        if (
          typeof subscription.type === "string" &&
          subscription.type.startsWith("0x")
        ) {
          const filter = {
            address: subscription.type,
            fromBlock: this.lastProcessedBlock + 1,
            toBlock: currentBlock,
          };
          const logs = await this.provider!.getLogs(filter);
          for (const log of logs) {
            subscription.listener(log);
          }
          this.lastProcessedBlock = currentBlock;
        }
      } catch (error) {
        console.error(
          `Error polling events for subscription ${subscription.type}:`,
          error
        );
      }
    }
  }

  private cleanupConnection() {
    if (this.keepAliveInterval) clearInterval(this.keepAliveInterval);
    if (this.pingTimeout) clearTimeout(this.pingTimeout);
    if (this.eventPollInterval) clearInterval(this.eventPollInterval);
  }

  private async resubscribe() {
    debug("Resubscribing to topics...");
    for (const subscription of this.subscriptions) {
      try {
        await this.provider?.on(subscription.type, subscription.listener);
        debug(`Resubscribed to ${JSON.stringify(subscription.type)}`);
      } catch (error) {
        console.error(error, `Failed to resubscribe to ${subscription.type}:`);
      }
    }
  }

  private sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

async function createResilientProviders(
  urls: string[],
  chainId: number
): Promise<WebSocketProvider[]> {
  const providers = await Promise.all(
    urls.map(async (url) => {
      try {
        const resilientProvider = new ResilientWebsocketProvider(url, chainId);
        const provider = await resilientProvider.connect();
        if (provider) {
          // Wrap the provider's 'on' method to track subscriptions
          const originalOn = provider.on.bind(provider);
          provider.on = (eventName: ProviderEvent, listener: Listener) => {
            resilientProvider.subscriptions.add({ type: eventName, listener });
            return originalOn(eventName, listener);
          };
        }
        return provider;
      } catch (error) {
        console.error(
          `Failed to create ResilientWebsocketProvider for ${url}:`,
          error
        );
        return null;
      }
    })
  );

  // Filter out any null providers (failed connections)
  return providers.filter(
    (provider) => provider !== null
  ) as WebSocketProvider[];
}

export { createResilientProviders, ResilientWebsocketProvider };
