/**
 * 资源库条目 → 资源树
 * --------------------
 * 资源库接口给的是“扁平文件列表 + 扁平文件夹列表”，这里按 `dir` / `parent`
 * 现场组装成树，供资源库主列表、视频侧栏、音频侧栏复用。
 *
 * 约定：
 *  - 只包含**传入条目**涉及的文件夹；视频/音频列表按类型过滤后不会出现空目录；
 *  - `folders` 可选：显式传入时补上还没放文件的空目录（资源库主列表需要）；
 *  - 排序固定“文件夹优先”，文件排序交给调用方的 compareFiles；
 *  - 每个文件夹节点带 `count`（其下所有层级文件数），用于树上的计数徽标。
 */
const collator = new Intl.Collator('zh-Hans-CN');

function isWithin(path, root) {
  return root === '' || path === root || path.startsWith(`${root}/`);
}

/**
 * @param {Array} entries 资源库文件条目
 * @param {{root?:string, folders?:Array, compareFiles?:(a:any,b:any)=>number}} [options]
 * @returns 根节点（type='folder'），文件/子目录都在 children 中
 */
export function buildResourceTree(entries, options = {}) {
  const { root = '', folders = [], compareFiles = (a, b) => collator.compare(a.name, b.name) } = options;
  const rootName = root ? root.split('/').pop() : '资源库';
  const nodes = new Map();

  function makeFolder(path, name) {
    return { type: 'folder', key: `folder:${path || '__root__'}`, path, name, children: [], count: 0 };
  }

  const rootNode = makeFolder(root, rootName);
  nodes.set(root, rootNode);

  /** 逐级补齐祖先目录，保证文件路径里的中间目录也出现在树上。 */
  function ensure(dir) {
    if (dir === root) return rootNode;
    const cached = nodes.get(dir);
    if (cached) return cached;
    const cut = dir.lastIndexOf('/');
    const parentPath = cut === -1 ? '' : dir.slice(0, cut);
    const parent = ensure(parentPath);
    const node = makeFolder(dir, cut === -1 ? dir : dir.slice(cut + 1));
    nodes.set(dir, node);
    parent.children.push(node);
    return node;
  }

  // 先放空目录，再放文件：同一个目录只会创建一次
  for (const folder of folders) {
    if (!folder.path || folder.path === root) continue;
    if (!isWithin(folder.path, root)) continue;
    ensure(folder.path);
  }

  for (const entry of entries) {
    if (!isWithin(entry.dir, root)) continue;
    ensure(entry.dir).children.push({
      type: 'file',
      key: `file:${entry.path}`,
      path: entry.path,
      name: entry.name,
      entry,
    });
  }

  function sortAndCount(node) {
    node.children.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
      if (a.type === 'folder') return collator.compare(a.name, b.name);
      return compareFiles(a.entry, b.entry) || collator.compare(a.name, b.name);
    });
    let count = 0;
    for (const child of node.children) {
      count += child.type === 'file' ? 1 : sortAndCount(child);
    }
    node.count = count;
    return count;
  }
  sortAndCount(rootNode);

  return rootNode;
}

/**
 * 收集树中所有文件夹路径（不含根节点），供「全部展开 / 全部折叠」使用。
 * @param {object} node 根节点
 * @returns {string[]}
 */
export function collectFolderPaths(node) {
  const paths = [];
  const walk = (parent) => {
    for (const child of parent.children) {
      if (child.type !== 'folder') continue;
      paths.push(child.path);
      walk(child);
    }
  };
  walk(node);
  return paths;
}

/**
 * 按折叠状态展开成可渲染的行。
 * @param {object} node 根节点
 * @param {Set<string>} collapsed 已折叠文件夹的相对路径
 * @param {number} [depth] 当前层级（根节点的子项为 0）
 */
export function flattenResourceTree(node, collapsed = new Set(), depth = 0) {
  const rows = [];
  for (const child of node.children) {
    rows.push({ ...child, depth });
    if (child.type === 'folder' && !collapsed.has(child.path)) {
      rows.push(...flattenResourceTree(child, collapsed, depth + 1));
    }
  }
  return rows;
}
