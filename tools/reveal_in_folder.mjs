export const revealInFolder={
  name:'reveal_in_folder',description:'Show a previous search result selected in Windows Explorer, using only resultId. Wait for the user to choose when multiple results are plausible.',
  parameters:{type:'object',properties:{resultId:{type:'string',pattern:'^[a-f0-9]{64}$'}},required:['resultId'],additionalProperties:false},
  outputSchema:{type:'object',properties:{status:{type:'string',enum:['launched','confirmation_required']},action:{type:'string'},resultId:{type:'string'},message:{type:'string'}},required:['status','action','resultId','message']},
  run(context,args){return context.files.act(context,'reveal',args.resultId);}
};
