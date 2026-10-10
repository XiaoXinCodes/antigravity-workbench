// Synthetic values, shaped like fetchAvailableModels in the inspected Cloud Code
// client/reactor contract. Never a recording of a real account or Google call.
exports.catalog=(id='synthetic-text-alpha')=>({
 models:{
  [id]:{displayName:'Synthetic account-specific conversation model with a very long English label',model:'MODEL_SYNTHETIC_AGENT',supportsImages:true,supportsVideo:true,supportedMimeTypes:{'image/png':true,'text/plain':true},quotaInfo:{remainingFraction:.6,resetTime:'2030-01-01T08:00:00Z'}},
  'synthetic-image-model':{displayName:'Synthetic image generation',model:'MODEL_SYNTHETIC_IMAGE',quotaInfo:{remainingFraction:1}},
  'synthetic-unlisted-model':{displayName:'Not in server agent choices'},
 },
 agentModelSorts:[{displayName:'Synthetic conversations',groups:[{modelIds:[id,'synthetic-image-model',id]}]}],
 imageGenerationModelIds:['synthetic-image-model'],
});
