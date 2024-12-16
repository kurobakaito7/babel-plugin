const { declare } = require("@babel/helper-plugin-utils");
const fse = require("fs-extra")
const path = require("path")
const { generate } = require("@babel/generator").default;

let intlIndex = 0;
function nextIntlKey() {
  ++intlIndex;
  return `intl${intlIndex}`;
}

const autoTrackPlugin = declare((api, options, dirname) => {
  api.assertVersion(7);

  // 生成替换节点
  function getReplaceExpression(path, value, intlUid) {
    const expressionParams = path.isTemplateLiteral()
      ? path.node.expressions.map((item) => generate(item).code)
      : null;
    let replaceExpression = api.template.ast(
      `${intlUid}.t('${value}'${
        expressionParams ? "," + expressionParams.join(",") : ""
      })`
    ).expression;
    // 如果是在 JSXAttribute 下，则必须用 JSXExpressionContainer 包裹（也就是{}）
    if (
      path.findParent((p) => p.isJSXAttribute()) &&
      !path.findParent((p) => p.isJSXExpressionContainer())
    ) {
      replaceExpression = api.types.JSXExpressionContainer(replaceExpression);
    }
    return replaceExpression;
  }

  // 收集替换的key和value，保存在file中
  function save(file, key, value) {
    const allText = file.get("allText");
    allText.push({
      key,
      value,
    });
    file.set("allText", allText);
  }
  return {
    pre(file) {
        file.set('allText', []);
    },
    visitor: {
      Program: {
        enter(path, state) {
          // 判断import是否引入了intl
          let imported;
          path.traverse({
            ImportDeclaration(p) {
              const source = p.node.source.value;
              if (source === "intl") {
                imported = true;
              }
            },
          });
          // 如果没引入 intl 模块，则引入，并且生成唯一 id 记录到 state 中
          if (!imported) {
            const uid = path.scope.generateUid("intl");
            const importAst = api.template.ast(`import ${uid} from 'intl'`);
            path.node.body.unshift(importAst);
            state.intlUid = uid;
          }

          // 处理 i18n-disable 注释的字符串和模版字符串
          path.traverse({
            "StringLiteral | templateLiteral"(path) {
              if (path.node.leadingComments) {
                // 过滤掉 i18n-disable 注释
                path.node.leadingComments = path.node.leadingComments.filter(
                  (comment, index) => {
                    if (comment.value.includes("i18n-disable")) {
                      // 标记跳过并从ast中去掉
                      path.node.skipTransform = true;
                      return false;
                    }
                    return true;
                  }
                );
              }
              // 模版字符串
              if (path.findParent((p) => p.isImportDeclaration())) {
                path.node.skipTransform = true;
              }
            },
          });
        },
      },
      // 处理 StringLiteral 和 TemplateLiteral 节点
      // 用 state.intlUid + '.t' 的函数调用语句来替换原节点
      StringLiteral(path, state) {
        if (path.node.skipTransform) {
          return;
        }
        let key = nextIntlKey();
        save(state.file, key, path.node.value);
        const replaceExpression = getReplaceExpression(
          path,
          key,
          state.intlUid
        );
        path.replaceWith(replaceExpression);
        path.skip();
      },
      TemplateLiteral(path, state) {
        if (path.node.skipTransform) {
          return;
        }
        // 将 expressions 作为参数引入
        const value = path
          .get("quasis")
          .map((item) => item.node.value.raw)
          .join("{placeholder}");
        if (value) {
          let key = nextIntlKey();
          save(state.file, key, value);
          const replaceExpression = getReplaceExpression(
            path,
            key,
            state.intlUid
          );
          path.replaceWith(replaceExpression);
          path.skip();
        }
      },
    },
    post(file) {
        const allText = file.get('allText');
        const intlData = allText.reduce((obj, item) => {
            obj[item.key] = item.value;
            return obj;
        }, {});

        const content = `const resource = ${JSON.stringify(intlData, null, 4)};\nexport default resource;`;
        fse.ensureDirSync(options.outputDir);
        fse.writeFileSync(path.join(options.outputDir, 'zh_CN.js'), content);
        fse.writeFileSync(path.join(options.outputDir, 'en_US.js'), content);
    },
  };
});
module.exports = autoTrackPlugin;
