import { useWebSocketImplementation, finalizeEvent, generateSecretKey, getPublicKey, SimplePool } from 'nostr-tools'

import Ws from "ws";
useWebSocketImplementation(Ws);

const context = {
    nostrRelays: ["wss://openagents.forkforge.net:7777"]
};

export async function runJobAndWait(eventReq, log=()=>{}) {
    // Initialize nostr if not already done
    if (!context.nostrPool) {
        context.nostrPool = new SimplePool();
        context.nostrPrivateKey = generateSecretKey();
        context.nostrPool.subscribeMany(context.nostrRelays, [
            {
                kinds: [7000]
            }
        ], {
            onevent: async (event) => {
                if (event.kind == 7000) {
                    const etag = event.tags.find(t => t[0] == "e");
                    if (!context.jobId || etag[1] != context.jobId) {
                        return;
                    }
                    const status = event.tags.find(t => t[0] == "status");
                    if (status && status[1] == "log") {
                        log(event.content);
                    } else if (status && status[1] == "error") {
                        log("Remote error: " + event.content);
                        
                    } else if (status && status[1] == "success") {
                        const filter = {
                            kinds: [6003],
                            "#e": [context.jobId],
                            limit: 1
                        };
                        log("Remote done. Find results using filter: " + JSON.stringify(filter, null, 2));
                        const result = await context.nostrPool.querySync(context.nostrRelays, filter);
                        const content = result[0].content;
                        log("Remote result: " + content);
                        context.jobPromise.resolve(content);
                        context.jobId = null;
                    }
                }
            }
        });
    }

    // Send job and wait
    const event = finalizeEvent(eventReq, context.nostrPrivateKey);
    log("Send job", event);
    context.jobId = event.id;
    return new Promise((resolve, reject) => {
        context.jobPromise = { resolve, reject };
        context.nostrPool.publish(context.nostrRelays, event);
    });
}
