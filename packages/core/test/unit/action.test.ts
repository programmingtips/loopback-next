// Copyright IBM Corp. 2013,2017. All Rights Reserved.
// Node module: loopback
// This file is licensed under the MIT License.
// License text available at https://opensource.org/licenses/MIT

import {expect} from '@loopback/testlab';
import * as util from 'util';
import {
  Context,
  inject,
  Setter,
  Reflector,
  BindingScope,
  invokeMethod,
} from '@loopback/context';

import {action, inspectAction, sortActions, sortActionClasses} from '../..';

// tslint:disable:no-any
describe('Action', () => {
  let ctx: Context;

  beforeEach(givenContext);

  /**
   * Mockup http header
   */
  interface HttpRequest {
    url: string;
    verb: string;
    headers: {[header: string]: string};
    query: {[param: string]: string};
  }

  /**
   * StopWatch records duration for a request. There are two action methods:
   * - start: Start the timer
   * - stop: Stop the timer and calculates the duration
   */
  @action({group: 'timer-group'})
  class StopWatch {
    /**
     * Start the timer (only to be invoked after http.request is set up)
     * @param startTime Use a setter to bind `startTime`
     */
    @action({dependsOn: ['http.request']})
    start(@inject.setter('startTime') startTime: Setter<Date>) {
      startTime(new Date());
    }

    /**
     * Calculate the duration
     * @param startTime
     */
    @action({bindsReturnValueAs: 'duration', dependsOn: ['invocation']})
    stop(@inject('startTime') startTime: Date): number {
      return new Date().getTime() - startTime.getTime();
    }
  }

  /**
   * Log the tracing id and duration for a given http request
   */
  @action({fulfills: ['logging']})
  class Logger {
    /**
     * @param prefix The logging prefix
     */
    constructor(@inject('log.prefix') private prefix: string) {}

    /**
     * The logging level
     */
    @inject('log.level') level: string = 'INFO';

    private lastMessage: string; // For testing

    /**
     * Log the request tracing id and duration
     * @param tracingId The tracing id
     * @param duration The duration
     */
    @action({dependsOn: ['invocation']})
    log(
      @inject('tracingId') tracingId: string,
      @inject('duration') duration: number,
    ) {
      this.lastMessage = util.format(
        `[%s][%s] TracingId: %s, Duration: %d`,
        this.level,
        this.prefix,
        tracingId,
        duration,
      );
      console.log(this.lastMessage);
    }
  }

  /**
   * Set up tracing id
   */
  @action()
  class Tracing {
    /**
     * Check and generate the tracing id for the http request
     * @param req The http request
     */
    @action({bindsReturnValueAs: 'tracingId'})
    setupTracingId(@inject('http.request') req: HttpRequest): string {
      let id = req.headers['X-Tracing-Id'];
      if (!id) {
        id = req.headers['X-Tracing-Id'] = 'tracing:' + process.hrtime();
      }
      return id;
    }
  }

  /**
   * Set up http request
   */
  @action()
  class HttpServer {
    @action()
    createRequest(
      @inject.setter('http.request') httpRequestSetter: Setter<HttpRequest>,
    ) {
      httpRequestSetter({
        verb: 'get',
        url: 'http://localhost:3000',
        query: {},
        headers: {},
      });
    }
  }

  /**
   * Mock-up invoker for controller methods
   */
  @action()
  class MethodInvoker {
    @action({
      bindsReturnValueAs: 'result',
      fulfills: ['invocation'],
      dependsOn: ['tracingId'],
    })
    // FIXME(rfeng) Allow controller.name/method/args to be injected
    invoke(): any {
      return new Promise((resolve, reject) => {
        // Artificially add 10ms delay to make duration significant
        setTimeout(() => {
          resolve('Hello, world');
        }, 10);
      });
    }
  }

  @action()
  class MyDummyAction {
    @action()
    static test(@inject('foo') foo: string) {}
  }

  it('captures class level action metadata for StopWatch', () => {
    const meta = Reflector.getMetadata('action', StopWatch);
    expect(meta).to.containEql({
      target: StopWatch,
      group: 'timer-group',
      fulfills: [],
      dependsOn: [],
    });
  });

  it('captures class level action metadata for Logger', () => {
    const meta = Reflector.getMetadata('action', Logger);
    expect(meta).to.containEql({
      target: Logger,
      group: 'class:Logger',
      fulfills: ['logging'],
      dependsOn: ['log.prefix', 'log.level'],
    });
  });

  it('captures method level action metadata', () => {
    const meta1 = Reflector.getMetadata('action', StopWatch.prototype, 'start');
    expect(meta1).to.eql({
      target: StopWatch.prototype,
      group: 'method:StopWatch.prototype.start',
      method: 'start',
      isStatic: false,
      fulfills: ['startTime'],
      dependsOn: ['http.request'],
    });

    const meta2 = Reflector.getMetadata('action', StopWatch.prototype, 'stop');
    expect(meta2).to.eql({
      target: StopWatch.prototype,
      group: 'method:StopWatch.prototype.stop',
      method: 'stop',
      isStatic: false,
      fulfills: ['duration'],
      dependsOn: ['startTime', 'invocation'],
      bindsReturnValueAs: 'duration',
    });
  });

  it('captures static method level action metadata', () => {
    const meta1 = Reflector.getMetadata('action', MyDummyAction, 'test');
    expect(meta1).to.eql({
      target: MyDummyAction,
      group: 'method:MyDummyAction.test',
      method: 'test',
      isStatic: true,
      fulfills: [],
      dependsOn: ['foo'],
    });
  });

  it('inspects action class', () => {
    const meta = inspectAction(StopWatch);
    expect(meta.target).to.exactly(StopWatch);
    expect(meta).to.containEql({
      target: StopWatch,
      group: 'timer-group',
      fulfills: [],
      dependsOn: [],
    });

    expect(meta.methods.start).to.containEql({
      target: StopWatch.prototype,
      group: 'method:StopWatch.prototype.start',
      method: 'start',
      fulfills: ['startTime'],
      dependsOn: ['http.request'],
    });

    expect(meta.methods.stop).to.containEql({
      target: StopWatch.prototype,
      group: 'method:StopWatch.prototype.stop',
      method: 'stop',
      fulfills: ['duration'],
      dependsOn: ['startTime', 'invocation'],
    });
  });

  it('inspects action class with inject.setter', () => {
    const meta = inspectAction(HttpServer);
    expect(meta.methods['createRequest'].fulfills).to.eql(['http.request']);
    expect(meta.methods['createRequest'].dependsOn).to.eql([]);
  });

  it('sorts action classes', () => {
    const nodes = sortActionClasses([Logger, StopWatch, HttpServer, Tracing])
      .actions;
    expect(
      nodes.map((n: any) => (typeof n === 'object' ? n.group : n)),
    ).to.eql([
      'log.prefix',
      'log.level',
      'class:Logger',
      'logging',
      'timer-group',
      'class:HttpServer',
      'class:Tracing',
    ]);
  });

  it('sorts action methods', () => {
    const nodes = sortActions([
      Logger,
      StopWatch,
      HttpServer,
      MethodInvoker,
      Tracing,
    ]).actions;

    expect(
      nodes.map((n: any) => (typeof n === 'object' ? n.group : n)),
    ).to.eql([
      'method:HttpServer.prototype.createRequest',
      'http.request',
      'method:StopWatch.prototype.start',
      'startTime',
      'method:Tracing.prototype.setupTracingId',
      'tracingId',
      'method:MethodInvoker.prototype.invoke',
      'invocation',
      'method:StopWatch.prototype.stop',
      'duration',
      'method:Logger.prototype.log',
      'result',
    ]);
  });

  it('bind action classes', () => {
    ctx.bind('log.level').to('INFO');
    ctx.bind('log.prefix').to('LoopBack');

    const classes = [Logger, StopWatch, HttpServer, MethodInvoker, Tracing];
    const nodes = sortActionClasses(classes, true).actions;

    for (const c of nodes) {
      ctx
        .bind('actions.' + c.target.name)
        .toClass(c.target)
        .inScope(BindingScope.SINGLETON);
    }

    nodes.forEach((c: any, index: number) => {
      const v = ctx.getSync('actions.' + c.target.name);
      expect(v instanceof classes[index]).to.be.true();
    });
  });

  it('generates a DOT based dependency graph for actions', async () => {
    const classes = [Logger, StopWatch, HttpServer, MethodInvoker, Tracing];
    const dot = sortActions(classes, true, true).toDot();
    expect(dot).to.eql(
      `digraph action_dependency_graph {
  "log.prefix" [shape="ellipse"];
  "log.level" [shape="ellipse"];
  "Logger" [shape="box"];
  "Logger" -> {"logging"};
  {"log.prefix" "log.level"} -> "Logger";
  "logging" [shape="ellipse"];
  "timer-group" [shape="box"];
  "HttpServer" [shape="box"];
  "HttpServer.prototype.createRequest" [shape="box", style="rounded"];
  "HttpServer.prototype.createRequest" -> {"http.request"};
  {"HttpServer"} -> "HttpServer.prototype.createRequest";
  "http.request" [shape="ellipse"];
  "StopWatch.prototype.start" [shape="box", style="rounded"];
  "StopWatch.prototype.start" -> {"startTime"};
  {"http.request" "timer-group"} -> "StopWatch.prototype.start";
  "startTime" [shape="ellipse"];
  "MethodInvoker" [shape="box"];
  "Tracing" [shape="box"];
  "Tracing.prototype.setupTracingId" [shape="box", style="rounded"];
  "Tracing.prototype.setupTracingId" -> {"tracingId"};
  {"http.request" "Tracing"} -> "Tracing.prototype.setupTracingId";
  "tracingId" [shape="ellipse"];
  "MethodInvoker.prototype.invoke" [shape="box", style="rounded"];
  "MethodInvoker.prototype.invoke" -> {"invocation" "result"};
  {"tracingId" "MethodInvoker"} -> "MethodInvoker.prototype.invoke";
  "invocation" [shape="ellipse"];
  "StopWatch.prototype.stop" [shape="box", style="rounded"];
  "StopWatch.prototype.stop" -> {"duration"};
  {"startTime" "invocation" "timer-group"} -> "StopWatch.prototype.stop";
  "duration" [shape="ellipse"];
  "Logger.prototype.log" [shape="box", style="rounded"];
  {"tracingId" "duration" "invocation" "Logger"} -> "Logger.prototype.log";
  "result" [shape="ellipse"];
}
`,
    );
  });

  it('creates a sequence of actions', async () => {
    ctx.bind('log.level').to('INFO');
    ctx.bind('log.prefix').to('LoopBack');

    const classes = [Logger, StopWatch, HttpServer, MethodInvoker, Tracing];
    const actions = sortActions(classes, true, true).actions;

    for (const c of actions.filter((a: any) => !a.method)) {
      ctx
        .bind('actions.' + c.target.name)
        .toClass(c.target)
        .inScope(BindingScope.SINGLETON);
    }

    for (const m of actions.filter((a: any) => !!a.method)) {
      const v = await ctx.get('actions.' + m.actionClass.target.name);
      const result = await invokeMethod(v, m.method, ctx);
      if (result !== undefined && m.bindsReturnValueAs) {
        ctx.bind(m.bindsReturnValueAs).to(result);
      }
    }
    const logger = await ctx.get('actions.Logger');
    expect(logger.lastMessage).to.match(
      /\[INFO\]\[LoopBack\] TracingId: tracing:\d+,\d+, Duration: \d+/,
    );
  });

  function givenContext() {
    ctx = new Context();
  }
});
