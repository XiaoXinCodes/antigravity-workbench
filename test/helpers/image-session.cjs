exports.memorySession = (state = {}) => ({load: async () => state.value && structuredClone(state.value), save: async value => { state.value = structuredClone(value); }, flush: async () => {}});
