// Copyright IBM Corp. 2013,2017. All Rights Reserved.
// Node module: loopback
// This file is licensed under the MIT License.
// License text available at https://opensource.org/licenses/MIT

import {
  Context,
  Reflector,
  Constructor,
  Injection,
  BindingScope,
  invokeMethod,
  describeInjectedArguments,
  describeInjectedProperties,
} from '@loopback/context';

// tslint:disable-next-line:variable-name
const Topo = require('topo');

export const ACTION_KEY = 'action';
export const ACTION_METHODS_KEY = 'action:methods';

// tslint:disable:no-any

/**
 * Metadata for actions
 */
export interface ActionMetadata {
  /**
   * Name of the group, default to the class or method name
   */
  group: string;
  /**
   * An array of events the action fulfills
   */
  fulfills: string[];
  /**
   * An array of events the action depends on
   */
  dependsOn: string[];
  /**
   * Target of the metadata. It is the class for action classes
   * or prototype for action methods
   */
  target: any;
}

export interface ActionMethod extends ActionMetadata {
  /**
   * Name of the method
   */
  method: string;
  /**
   * Specify a key to bind the return value into the context
   */
  bindsReturnValueAs?: string;
  /**
   * The action class
   */
  actionClass?: ActionClass;
  /**
   * Is the method static
   */
  isStatic: boolean;
}

export interface ActionClass extends ActionMetadata {
  methods: {[name: string]: ActionMethod};
}

/**
 * Normalize the binding keys to be unique and without #
 * @param keys An array of binding keys
 */
function normalizeKeys(keys?: string[]) {
  keys = keys || [];
  keys = keys.map(k => k.split('#')[0]);
  keys = Array.from(new Set(keys));
  return keys;
}

/**
 * Populate dependsOn/fulfills into the action metadata
 * @param actionMetadata Action metadata
 * @param injections An array of injections
 */
function populateActionMetadata(
  actionMetadata: ActionMetadata,
  injections: Injection[],
) {
  // Add dependsOn from @inject
  let dependsOn = injections
    // Skip @inject.setter
    .filter(p => !(p.metadata && p.metadata.setter))
    .map(p => p.bindingKey);

  dependsOn = dependsOn.concat(actionMetadata.dependsOn);
  actionMetadata.dependsOn = normalizeKeys(dependsOn);

  // Add fulfills from @inject
  let fulfills = injections
    // Only include @inject.setter
    .filter(p => p.metadata && p.metadata.setter)
    .map(p => p.bindingKey);

  fulfills = fulfills.concat(actionMetadata.fulfills);
  actionMetadata.fulfills = normalizeKeys(fulfills);
  return actionMetadata;
}

/**
 * Decorator for Action classes and methods, for example,
 * ```ts
 * @action({group: 'my-group', fulfills: ['key1'], dependsOn: ['key2']})
 * class MyAction {
 *   constructor(@inject('dep1') private dep1: ClassLevelDep) {}
 *
 *   @inject('dep2')
 *   private dep2: PropertyLevelDep;
 *
 *   @action({fulfills: ['dep4']})
 *   action1(@inject('dep3') dep3: MethodLevelDepA) {...}
 *
 *   @action()
 *   action2(@inject('dep4') dep4: MethodLevelDepB) {...}
 * }
 * ```
 * @param meta Action metadata
 */
export function action(meta?: Partial<ActionClass | ActionMethod>) {
  return function(target: any, method?: string | symbol) {
    let group: string;
    let isStatic = false;
    if (method) {
      if (typeof target === 'function') {
        // Static method
        group = `method:${target.name}.${method}`;
        isStatic = true;
      } else {
        group = `method:${target.constructor.name}.prototype.${method}`;
      }
    } else {
      group = `class:${target.name}`;
    }
    if (meta && meta.group) {
      group = meta.group;
    }
    let actionMetadata: ActionMetadata;
    actionMetadata = method
      ? <ActionMethod>{
          target,
          method,
          isStatic,
          group,
          fulfills: [],
          dependsOn: [],
        }
      : {
          target,
          group,
          fulfills: [],
          dependsOn: [],
        };

    if (meta && meta.fulfills) {
      actionMetadata.fulfills = meta.fulfills;
    }
    if (meta && meta.dependsOn) {
      actionMetadata.dependsOn = meta.dependsOn;
    }
    if (method) {
      // Method level decoration

      // First handle bindReturnValueAs
      const methodMeta = <Partial<ActionMethod>>meta;
      if (meta && methodMeta.bindsReturnValueAs) {
        (<ActionMethod>actionMetadata).bindsReturnValueAs =
          methodMeta.bindsReturnValueAs;
        actionMetadata.fulfills.push(methodMeta.bindsReturnValueAs);
      }

      // Process method parameters
      const injections = describeInjectedArguments(target, method);
      populateActionMetadata(actionMetadata, injections);
      Reflector.defineMetadata(ACTION_KEY, actionMetadata, target, method);

      // Aggregate all methods for simpler retrieval
      const actionMethods: {[p: string]: ActionMethod} =
        Reflector.getOwnMetadata(ACTION_METHODS_KEY, target) || {};
      actionMethods[method] = <ActionMethod>actionMetadata;
      Reflector.defineMetadata(ACTION_METHODS_KEY, actionMethods, target);
    } else {
      // Class level decoration
      let injections: Injection[] = [];
      injections = injections.concat(describeInjectedArguments(target));
      const propertyInjections = describeInjectedProperties(target.prototype);
      for (const m in propertyInjections) {
        injections.push(propertyInjections[m]);
      }
      populateActionMetadata(actionMetadata, injections);
      Reflector.defineMetadata(ACTION_KEY, actionMetadata, target);
    }
  };
}

/**
 * Inspect action metadata for a given class
 * @param cls Action class
 */
export function inspectAction(cls: Constructor<any>) {
  const descriptor: ActionClass = Object.assign(
    {},
    Reflector.getMetadata(ACTION_KEY, cls),
  );
  descriptor.methods = Object.assign(
    {},
    Reflector.getMetadata(ACTION_METHODS_KEY, cls.prototype),
  );
  for (const m in descriptor.methods) {
    descriptor.methods[m].actionClass = descriptor;
  }
  return descriptor;
}

/**
 * Add action metadata to the dependency graph
 * @param graph The topological sorting graph
 * @param meta Action metadata
 */
function addActionToGraph(graph: any, meta: ActionMetadata) {
  const exists = (g: string) => {
    return graph._items.some((i: any) => i.group === g);
  };
  // Add out edges for all fulfills
  for (const f of meta.fulfills) {
    if (!exists(f)) {
      graph.add(f, {group: f});
    }
  }
  // Add in edges for all dependsOn
  for (const d of meta.dependsOn) {
    if (!exists(d)) {
      graph.add(d, {group: d});
    }
  }
  // Add action between dependsOn and fulfills
  graph.add(meta, {
    group: meta.group,
    before: meta.fulfills,
    after: meta.dependsOn,
  });
}

/**
 * See http://www.graphviz.org/content/dot-language
 * @param graph The topological sorting graph
 * @param attrs: An object of graphviz node attributes for state/class/method
 */
function generateDot(graph: any, attrs?: GraphvizNodeAttributes) {
  const dot: string[] = [];
  dot.push('digraph action_dependency_graph {');

  const normalize = (group: string) => {
    if (group.indexOf('class:') === 0) {
      group = group.substring('class:'.length);
    }
    if (group.indexOf('method:') === 0) {
      group = group.substring('method:'.length);
    }
    return `"${group}"`;
  };

  const {
    stateAttrs = '[shape="ellipse"]',
    classAttrs = '[shape="box"]',
    methodAttrs = '[shape="box", style="rounded"]',
  } =
    attrs || {};

  for (const item of graph._items) {
    /*
      interface Item {
      seq: number;
      sort?: number;
      before: string[];
      after: string[];
      group: string;
      node: any;
    }
    */
    const before = item.before.map(normalize).join(' ');
    const after = item.after.map(normalize).join(' ');
    const group = normalize(item.group);

    if (typeof item.node === 'string') {
      dot.push(`  ${group} ${stateAttrs};`);
    } else if (item.node.method) {
      // Method
      dot.push(`  ${group} ${methodAttrs};`);
    } else {
      // Class
      dot.push(`  ${group} ${classAttrs};`);
    }
    if (before) dot.push(`  ${group} -> {${before}};`);
    if (after) dot.push(`  {${after}} -> ${group};`);
  }
  dot.push('}\n');
  return dot.join('\n');
}

/**
 * Attributes to control how to render state/class/method nodes
 */
export interface GraphvizNodeAttributes {
  stateAttrs?: string;
  classAttrs?: string;
  methodAttrs?: string;
}

/**
 * Dependency graph for actions
 */
export class ActionGraph {
  /**
   * Ana array of action metadata
   */
  public actions: any[];

  constructor(
    public graph: any,
    actions?: (ActionMethod | ActionClass | string)[],
  ) {
    this.actions = actions ? actions : graph.nodes;
  }

  /**
   * Generate graphviz diagram in DOT format
   */
  toDot(attrs?: GraphvizNodeAttributes) {
    return generateDot(this.graph, attrs);
  }
}

/**
 * Sort action classes based on fulfills/dependsOn
 * @param actionClasses An array of action classes
 * @param removeKeys Remove binding keys from the sorted result
 */
export function sortActionClasses(
  actionClasses: Constructor<any>[],
  removeKeys?: boolean,
): ActionGraph {
  const graph = new Topo();
  for (const cls of actionClasses) {
    const meta = Reflector.getMetadata(ACTION_KEY, cls);

    addActionToGraph(graph, meta);
  }
  if (!removeKeys) return new ActionGraph(graph);
  // Filter out the binding keys
  return new ActionGraph(
    graph,
    graph.nodes.filter((n: any) => typeof n === 'object'),
  );
}

/**
 * Sort action methods based on fulfills/dependsOn
 * @param actionClasses An array of action classes
 * @param removeKeys Remove binding keys from the sorted result
 */
export function sortActions(
  actionClasses: Constructor<any>[],
  includeClasses?: boolean,
  removeKeys?: boolean,
): ActionGraph {
  const graph = new Topo();
  for (const cls of actionClasses) {
    const meta = inspectAction(cls);
    if (includeClasses) addActionToGraph(graph, meta);
    for (const m in meta.methods) {
      const method = meta.methods[m];
      if (includeClasses) {
        // Make the method depend on the class
        method.dependsOn.push(meta.group);
      }
      addActionToGraph(graph, method);
    }
  }
  if (!removeKeys) return new ActionGraph(graph);
  // Filter out the binding keys
  return new ActionGraph(
    graph,
    graph.nodes.filter((n: any) => typeof n === 'object'),
  );
}

export class Sequence extends Context {
  private actionGraph: ActionGraph;

  constructor(private actionClasses: Constructor<any>[], ctx?: Context) {
    super(ctx);
    this.bindClasses();
  }

  private bindClasses() {
    for (const c of this.actionClasses) {
      this
        .bind('actions.' + c.name)
        .toClass(c)
        .inScope(BindingScope.SINGLETON);
    }
  }

  private buildGraph() {
    if (!this.actionGraph) {
      this.actionGraph = sortActions(this.actionClasses, true, false);
    }
    return this.actionGraph;
  }

  toDOT() {
    return this.buildGraph().toDot();
  }

  async run() {
    const ctx = this;
    const actions = this.buildGraph().actions;
    for (const m of actions.filter((a: any) => !!a.method)) {
      const v = await ctx.get('actions.' + m.actionClass.target.name);
      const result = await invokeMethod(v, m.method, ctx);
      if (result !== undefined && m.bindsReturnValueAs) {
        ctx.bind(m.bindsReturnValueAs).to(result);
      }
    }
  }

  reset() {
    this.registry.clear();
    this.bindClasses();
  }

}
