import { useWebSocketImplementation, finalizeEvent, generateSecretKey, getPublicKey, SimplePool, nip04 } from 'nostr-tools'

import Ws from "ws";
useWebSocketImplementation(Ws);

const context = {
    nostrRelays: ["wss://nostr.openagents.com:7777"]
};
async function decryptEvent(event, secret) {
    try {
        const kind = event.kind;
        if (kind >= 5000 && kind < 6000) { // job request
            const encryptedPayload = event.content;
            if (encryptedPayload) {
                const decryptedPayload = await nip04.decrypt(secret, event.pubkey, encryptedPayload);
                const decryptedTags = JSON.parse(decryptedPayload);
                event.tags.push(...decryptedTags);
            }
        } else if (kind >= 6000 && kind <= 6999) { // job response
            const encryptedPayload = event.content;
            if (encryptedPayload) {
                const decryptedPayload = await nip04.decrypt(secret, event.pubkey, encryptedPayload);
                event.content = decryptedPayload;
            }
        } else if (kind == 7000) {
            const encryptedPayload = event.content;
            if (encryptedPayload) {
                const decryptedPayload = await nip04.decrypt(secret, event.pubkey, encryptedPayload);
                event.content = decryptedPayload;
            }
        }
    } catch (e) {
    }
    return event;
}

function getTagVars(event, tagName) {
    const results = []
    for (const t of event.tags) {
        let isMatch = true;
        if (Array.isArray(tagName)) {
            for (let i = 0; i < tagName.length; i++) {
                if (t[i] !== tagName[i]) {
                    isMatch = false;
                    break;
                }
            }
        } else {
            isMatch = t[0] === tagName;
        }
        if (!isMatch) continue;
        const values = t.slice(Array.isArray(tagName) ? tagName.length : 1);
        results.push(values);
    }
    if (results.length == 0) {
        results.push([]);
    }
    return results;
}
async function encryptEvent(event, secret) {
    const p = getTagVars(event, ["p"])[0][0];
    if (!p) {
        console.warn("No public key found in event. Can't encrypt");
        return event;
    }

    const encryptedTag = getTagVars(event, ["encrypted"])[0][0];


    const kind = event.kind;
    if (kind >= 5000 && kind < 6000) { // job request
        const tags = event.tags;
        const tagsToEncrypt = [];
        for (let i = 0; i < tags.length; i++) {
            if (tags[i][0] == "i") {
                tagsToEncrypt.push(tags[i]);
                tags.splice(i, 1);
                i--;
            }
        }
        const encryptedTags = await nip04.encrypt(secret, p, JSON.stringify(tagsToEncrypt));
        event.content = encryptedTags;
    } else if (kind >= 6000 && kind <= 6999) { // job response
        const encryptedPayload = await nip04.encrypt(secret, p, event.content);
        event.content = encryptedPayload;
    } else if (kind == 7000) {
        const encryptedPayload = await nip04.encrypt(secret, p, event.content);
        event.content = encryptedPayload;
    }

    if (!encryptedTag) {
        event.tags.push(["encrypted", "true"]);
    }
    return event;

}

export async function runJobAndWait(eventReq, log=()=>{}, encryptFor = "") {
    // Initialize nostr if not already done
    if (!context.nostrPool) {
        console.log("Connect to relays", context.nostrRelays);
        context.nostrPool = new SimplePool();
        context.nostrPrivateKey = generateSecretKey();
        context.nostrPool.subscribeMany(context.nostrRelays, [
            {
                kinds: [7000]
            }
        ], {
            onevent: async (event) => {
                const encryptedTag = getTagVars(event, ["encrypted"])[0][0];
                if(encryptedTag){
                    log("Encrypted event", event);
                    event = await decryptEvent(event, context.nostrPrivateKey);
                    log("Decrypted event", event);
                }
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
                        let event = result[0];
                        const encryptedTag = getTagVars(event, ["encrypted"])[0][0];
                        if (encryptedTag) {
                            // log("Encrypted event", event);
                            event = await decryptEvent(event, context.nostrPrivateKey);
                            // log("Decrypted event", event);
                        }                        
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
    if (encryptFor){
        eventReq.tags.push(["p", encryptFor]);
        eventReq.tags.push(["encrypted", "true"]);
        log("Encrypting event", eventReq);
        eventReq = await encryptEvent(eventReq, context.nostrPrivateKey);
        log("Encrypted event", eventReq);

    }
    const event = finalizeEvent(eventReq, context.nostrPrivateKey);
    log("Send job", event);
    context.jobId = event.id;
    return new Promise((resolve, reject) => {
        context.jobPromise = { resolve, reject };
        context.nostrPool.publish(context.nostrRelays, event);
    });
}
