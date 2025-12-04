/** The Standard Schema interface. */ function parseWithDictionary(dictionary, value) {
    const result = {};
    const issues = [];
    for(const key in dictionary){
        const schema = dictionary[key];
        const prop = value[key];
        const propResult = schema["~standard"].validate(prop);
        if (propResult instanceof Promise) {
            throw new Error(`Validation must be synchronous, but ${key} returned a Promise.`);
        }
        if (propResult.issues) {
            issues.push(...propResult.issues.map((issue)=>({
                    ...issue,
                    path: [
                        key,
                        ...issue.path ?? []
                    ]
                })));
            continue;
        }
        result[key] = propResult.value;
    }
    if (issues.length) {
        return {
            issues
        };
    }
    return {
        value: result
    };
}

function createEnv(opts) {
    const runtimeEnv = opts.runtimeEnvStrict ?? opts.runtimeEnv ?? process.env;
    const emptyStringAsUndefined = opts.emptyStringAsUndefined ?? false;
    if (emptyStringAsUndefined) {
        for (const [key, value] of Object.entries(runtimeEnv)){
            if (value === "") {
                delete runtimeEnv[key];
            }
        }
    }
    const skip = !!opts.skipValidation;
    // biome-ignore lint/suspicious/noExplicitAny: <explanation>
    if (skip) return runtimeEnv;
    const _client = typeof opts.client === "object" ? opts.client : {};
    const _server = typeof opts.server === "object" ? opts.server : {};
    const _shared = typeof opts.shared === "object" ? opts.shared : {};
    const isServer = opts.isServer ?? (typeof window === "undefined" || "Deno" in window);
    const finalSchema = isServer ? {
        ..._server,
        ..._shared,
        ..._client
    } : {
        ..._client,
        ..._shared
    };
    const parsed = parseWithDictionary(finalSchema, runtimeEnv);
    const onValidationError = opts.onValidationError ?? ((issues)=>{
        console.error("❌ Invalid environment variables:", issues);
        throw new Error("Invalid environment variables");
    });
    const onInvalidAccess = opts.onInvalidAccess ?? (()=>{
        throw new Error("❌ Attempted to access a server-side environment variable on the client");
    });
    if (parsed.issues) {
        return onValidationError(parsed.issues);
    }
    const isServerAccess = (prop)=>{
        if (!opts.clientPrefix) return true;
        return !prop.startsWith(opts.clientPrefix) && !(prop in _shared);
    };
    const isValidServerAccess = (prop)=>{
        return isServer || !isServerAccess(prop);
    };
    const ignoreProp = (prop)=>{
        return prop === "__esModule" || prop === "$$typeof";
    };
    const extendedObj = (opts.extends ?? []).reduce((acc, curr)=>{
        return Object.assign(acc, curr);
    }, {});
    const fullObj = Object.assign(parsed.value, extendedObj);
    const env = new Proxy(fullObj, {
        get (target, prop) {
            if (typeof prop !== "string") return undefined;
            if (ignoreProp(prop)) return undefined;
            if (!isValidServerAccess(prop)) return onInvalidAccess(prop);
            return Reflect.get(target, prop);
        }
    });
    // biome-ignore lint/suspicious/noExplicitAny: <explanation>
    return env;
}

export { createEnv };
