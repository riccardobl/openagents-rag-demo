import OpenAI from "openai";
import { runJobAndWait } from "./NostrHelper.js";
import Readline from "readline";


/// THIS STUFF SHOULD BE FROM THE UI BUILDER
const WELCOME_MESSAGE="Ask me anything about Livewire";

const PROMPT=`\
You are the Livewire chat assistant.
Answer the user with short concise answers using code samples when possible.
You can use the following CONTEXT to help you answer the user's questions.

CONTEXT:
%CONTEXT%


`;


const RETRIEVAL_PROMPT=`\
Given the following chat history between user and assistant, \
answer with a fully qualified standalone question about Livewire that summarize the user's question. \

CHAT HISTORY:
%HISTORY%

FULLY QUALIFIED QUESTION: `;


const DOCUMENTS = [
    ""
];
/////////////////////////////////////////

// This is the array that holds the chat history
const CHAT_HISTORY = [
    {
        "role": "system", // system prompt here
        "content": "" // placeholder
    }
];

// Returns the history for the chat assistant
const getHistory = (context)=>{
    CHAT_HISTORY[0].content = PROMPT.replace("%CONTEXT%", context);
    return CHAT_HISTORY;
}


// Returns the history for the retrieval prompt
const getHistoryForRAG = (n=10)=>{
    const chatHistory = getHistory("");
    let historyForRag = "";
    // get last n messages
    for(let i=0; i<n; i++){
        const j=chatHistory.length-1-i;
        if(j<1) break; // skip system prompt
        historyForRag = `${chatHistory[j].role}: ${chatHistory[j].content}\n${historyForRag}`;
    }
    return [
        {
            "role": "system",
            "content": RETRIEVAL_PROMPT.replace("%HISTORY%", historyForRag)
        }
    ];
}


// Add an history entry by the user
const userInput = (input)=>{
    CHAT_HISTORY.push({
        "role": "user",
        "content": input
    });
    return CHAT_HISTORY;
}


// Add an history entry by the assistant
const assistantResponse = (response)=>{
    CHAT_HISTORY.push({
        "role": "assistant",
        "content": response
    });
    return CHAT_HISTORY;
}


// Get the event that will start the rag pipeline
const getRAGEvent = (question)=>{
    return {
        "kind": 5003,
        "created_at": Math.floor(Date.now() / 1000),
        "tags": [
            ["param","run-on","openagents/extism-runtime"],
            ["expiration", "" + Math.floor((Date.now() + 1000 * 60 * 5) / 1000) ],
            ["param","main","https://github.com/riccardobl/openagents-rag-coordinator-plugin/raw/master/rag.wasm"],
            ["param","k","3"],
            ["param","max-tokens","256"],
            ["param","quantize","true"],
            ...DOCUMENTS.map((doc) => ["i", doc, "url", "", "passage"]),
            ["i",question, "text", "", "query"]
        ],
        "content": ""
    };
};




// entry point
async function main(){

    // Print welcome message
    console.info(WELCOME_MESSAGE+"\n   Enter d for debug mode.\n   Enter q to exit")

    let DEBUG_MODE=false; // a toggle for debug mode (shows all system logging)
    let CONTEXT = ""; // this variable holds the last context
    const openai = new OpenAI();

    // This is a logging helper that will log only if DEBUG_MODE is true
    const log = (...msg)=>{
        if(DEBUG_MODE){
            console.log(...msg);
        }    
    };


    // Main loop
    while(true){

        // Suboptimal way to get user input from console
        const rl = Readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });
        const input = await new Promise((resolve, reject)=>{
            rl.question("> ", (input)=>{
                resolve(input);
                rl.close();
            });
        });
        //

        if(input==="d"){ // debug mode toggler
            DEBUG_MODE = !DEBUG_MODE;
            console.info(`Debug mode is now ${DEBUG_MODE}`);
            continue;
        }else if(input==="q"){ // quit
            console.info("Goodbye!");
            break;
        }else{ // user input
            userInput(input);
        }

     
        {   // THE RAG PIPELINE
            const ragChat = getHistoryForRAG(10);
            log("Using LLM to get a fully qualified question for this chat: \n", JSON.stringify(ragChat, null, 2));
            const completion = await openai.chat.completions.create({
                messages: ragChat,
                model: "gpt-3.5-turbo",
            });    
            const query = completion.choices[0].message.content.trim();
            if(query==="NOP"){ // No extra context needed. Skip RAG pipeline
                log("No extra context needed. Skipping RAG.")
            }else{
                log("Lookup for query: ", query);
                console.log("??? " + query+"... searching...")
                // so basically we send an event to nostr and then we wait
                const ragEvent = getRAGEvent(query);
                const jobResult = await runJobAndWait(ragEvent, log);
                // whatever we get as the result for the nip-90 job is the new context
                CONTEXT = jobResult;                
                log("Received new context", CONTEXT);
            }
        }

        // Now we have the updated new context. 
        // So we will use it to augment the knowledge of the LLM
        // and answer the user's question
        
        log("Preparing to answer user's question. With new context: ", CONTEXT);
        const chatHistory = getHistory(CONTEXT);
        log("Chat history: \n", JSON.stringify(chatHistory, null, 2));

        const completion = await openai.chat.completions.create({
            messages: chatHistory,
            model: "gpt-3.5-turbo",
            stream: true,
        });

        // We stream the response to the console
        let response = "";
        for await (const chunk of completion) {
            response+=chunk.choices[0].delta.content;
            process.stdout.write(chunk.choices[0].delta.content||""); // this is needed to stream the response
        }
        
        // Good now we append the final response to the history 
        log("Final response: ", response);
        assistantResponse(response);
        log("Final chat history: \n", JSON.stringify(CHAT_HISTORY, null, 2));


        // Go back to the top of the loop        
    }
}

main();