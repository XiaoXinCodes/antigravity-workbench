// Architecture check, not a grep gate: parse TypeScript, check model decisions,
// directory interpretation ownership and configuration defaults. Paired with
// randomized identity-renaming tests of the actual parsers and wire builders.
const fs = require('node:fs'), path = require('node:path'), ts = require('typescript');
const catalogFields = new Set(['imageGenerationModelIds', 'agentModelSorts', 'supportsImages', 'quotaInfo']);
const modelExpression = node => /\b(?:modelId|modelID)\b|\bmodel\.id\b/.test(node.getText());
const vendor = /(?:gemini|claude|gpt|imagen|sonnet|opus|haiku|nano.?banana)(?:[-_ .]?(?:\d|pro|flash|lite|sonnet|opus)|$)/i;
function inspect(file, source) {
  const errors = [], tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const report = (node, rule) => errors.push(`${file}:${tree.getLineAndCharacterOfPosition(node.getStart()).line + 1}: ${rule}`);
  const modelBoundary = /(?:model-catalog|direct-image-binding|direct-image-protocol|wake-model-catalog|wake-transport)\.ts$/.test(file);
  const visit = node => {
    if (ts.isStringLiteralLike(node) || ts.isRegularExpressionLiteral(node)) {
      const text = ts.isRegularExpressionLiteral(node) ? node.text.slice(1, node.text.lastIndexOf('/')) : node.text;
      // Native credential names/paths and environment keys are protocol identifiers.
      const native = text.includes('.gemini') || text.includes('gemini:antigravity') || /^[A-Z_]+$/.test(text) || ['gemini', 'antigravity'].includes(text) && /live-storage\.ts$/.test(file);
      if (!native && vendor.test(text)) report(node, 'vendor/model literal or regular expression');
    }
    if (ts.isPropertyAccessExpression(node) && catalogFields.has(node.name.text) && !/(?:model-catalog|live-hub)\.ts$/.test(file)) report(node, 'catalog interpretation must live in model-catalog.ts (Hub quota is a separate protocol)');
    if (ts.isBinaryExpression(node) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(node.operatorToken.kind)) {
      for (const [literal, other] of [[node.left, node.right], [node.right, node.left]]) if (ts.isStringLiteralLike(literal) && literal.text && !ts.isTypeOfExpression(other) && modelExpression(other)) report(node, 'model identity compared with a static literal');
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ['startsWith', 'endsWith', 'includes', 'match', 'search'].includes(node.expression.name.text) && modelExpression(node.expression.expression)) report(node, 'model identity used for inference');
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'test' && ts.isRegularExpressionLiteral(node.expression.expression)) {
      let parent = node.parent, context = '';
      while (parent) { if (ts.isFunctionDeclaration(parent) && parent.name) { context = parent.name.text; break; } parent = parent.parent; }
      if ((node.arguments.some(modelExpression) || /model|catalog/i.test(context)) && /(?:image|thinking|sonnet|opus|flash|pro)/i.test(node.expression.expression.text)) report(node, 'model role inferred by regular expression');
    }
    if (ts.isPropertyAssignment(node) && ts.isStringLiteralLike(node.initializer) && node.initializer.text && (['modelId', 'modelID'].includes(node.name.getText()) || modelBoundary && ['id', 'model'].includes(node.name.getText()))) report(node, 'static callable model identity');
    if (ts.isPropertyAssignment(node) && ['modelEnum', 'model_enum'].includes(node.name.getText()) && ts.isStringLiteralLike(node.initializer)) report(node, 'static model enumeration');
    if (ts.isBinaryExpression(node) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(node.operatorToken.kind) && /model(?:Id|ID|Enum|_enum)?\b/i.test(node.left.getText()) && ts.isStringLiteralLike(node.right) && node.right.text) report(node, 'static model fallback');
    if (ts.isVariableDeclaration(node) && /model.*(?:names|aliases|ids|defaults|map|list)$/i.test(node.name.getText()) && node.initializer && (ts.isArrayLiteralExpression(node.initializer) || ts.isObjectLiteralExpression(node.initializer)) && /["']/.test(node.initializer.getText())) report(node, 'static model table');
    ts.forEachChild(node, visit);
  };
  visit(tree); return errors;
}
function check(root) {
  const errors = [];
  const walk = dir => { for (const item of fs.readdirSync(dir, { withFileTypes: true })) { const file = path.join(dir, item.name); if (item.isDirectory()) walk(file); else if (file.endsWith('.ts')) errors.push(...inspect(file, fs.readFileSync(file, 'utf8'))); } };
  walk(path.join(root, 'src'));
  const properties = require(path.join(root, 'package.json')).contributes.configuration.properties;
  for (const [key, value] of Object.entries(properties)) if (/model/i.test(key) && (value.default || value.enum)) errors.push(`package.json: static model setting ${key}`);
  return errors;
}
module.exports = { inspect, check };
if (require.main === module) {
  const errors = check(path.resolve(__dirname, '..'));
  if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
  else console.log('Model architecture: no static model identities, name-based decisions, or duplicate catalog interpreters.');
}
