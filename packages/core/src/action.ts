// Copyright IBM Corp. 2013,2017. All Rights Reserved.
// Node module: loopback
// This file is licensed under the MIT License.
// License text available at https://opensource.org/licenses/MIT

import {
  Reflector,
  Constructor,
  Injection,
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
   * Name of the action, default to the class or method name
   */
  name: string;
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
 * @action({name: 'my-action', fulfills: ['key1'], dependsOn: ['key2']})
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
    let name;
    if (method) {
      name = `${target.constructor.name}.${method}`;
    } else {
      name = target.name;
    }
    if (meta && meta.name) {
      name = meta.name;
    }
    let actionMetadata: ActionMetadata;
    actionMetadata = method
      ? <ActionMethod>{
          target,
          method,
          name,
          fulfills: [],
          dependsOn: [],
        }
      : {
          target,
          name,
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

function addActionToGraph(graph: any, meta: ActionMetadata) {
  // Add out edges for all fulfills
  for (const p of meta.fulfills) {
    if (graph.nodes.indexOf(p) === -1) {
      graph.add(p, {group: p});
    }
  }
  // Add in edges for all fulfills
  for (const c of meta.dependsOn) {
    if (graph.nodes.indexOf(c) === -1) {
      graph.add(c, {group: c});
    }
  }
  // Add method between dependsOn and fulfills
  graph.add(meta, {
    group: meta.name,
    before: meta.fulfills,
    after: meta.dependsOn,
  });
}

/**
 * Sort action classes based on fulfills/dependsOn
 * @param actionClasses An array of action classes
 * @param removeKeys Remove binding keys from the sorted result
 */
export function sortActionClasses(
  actionClasses: Constructor<any>[],
  removeKeys?: boolean,
) {
  const graph = new Topo();
  for (const cls of actionClasses) {
    const meta = Reflector.getMetadata(ACTION_KEY, cls);

    addActionToGraph(graph, meta);
  }
  if (!removeKeys) return graph.nodes;
  // Filter out the binding keys
  return graph.nodes.filter((n: any) => typeof n === 'object');
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
) {
  const graph = new Topo();
  for (const cls of actionClasses) {
    const meta = inspectAction(cls);
    if (includeClasses) addActionToGraph(graph, meta);
    for (const m in meta.methods) {
      const method = meta.methods[m];
      if (includeClasses) {
        // Make the method depend on the class
        method.dependsOn.push(meta.name);
      }
      addActionToGraph(graph, method);
    }
  }
  if (!removeKeys) return graph.nodes;
  // Filter out the binding keys
  return graph.nodes.filter((n: any) => typeof n === 'object');
}
