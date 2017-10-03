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
  @action({name: 'RoundtripTimer'})
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

  it('captures class level action metadata for StopWatch', () => {
    const meta = Reflector.getMetadata('action', StopWatch);
    expect(meta).to.containEql({
      target: StopWatch,
      name: 'RoundtripTimer',
      fulfills: [],
      dependsOn: [],
    });
  });

  it('captures class level action metadata for Logger', () => {
    const meta = Reflector.getMetadata('action', Logger);
    expect(meta).to.containEql({
      target: Logger,
      name: 'Logger',
      fulfills: ['logging'],
      dependsOn: ['log.prefix', 'log.level'],
    });
  });

  it('captures method level action metadata', () => {
    const meta1 = Reflector.getMetadata('action', StopWatch.prototype, 'start');
    expect(meta1).to.eql({
      target: StopWatch.prototype,
      name: 'StopWatch.start',
      method: 'start',
      fulfills: ['startTime'],
      dependsOn: ['http.request'],
    });

    const meta2 = Reflector.getMetadata('action', StopWatch.prototype, 'stop');
    expect(meta2).to.eql({
      target: StopWatch.prototype,
      name: 'StopWatch.stop',
      method: 'stop',
      fulfills: ['duration'],
      dependsOn: ['startTime', 'invocation'],
      bindsReturnValueAs: 'duration',
    });
  });

  it('inspects action class', () => {
    const meta = inspectAction(StopWatch);
    expect(meta.target).to.exactly(StopWatch);
    expect(meta).to.containEql({
      target: StopWatch,
      name: 'RoundtripTimer',
      fulfills: [],
      dependsOn: [],
    });

    expect(meta.methods.start).to.containEql({
      target: StopWatch.prototype,
      name: 'StopWatch.start',
      method: 'start',
      fulfills: ['startTime'],
      dependsOn: ['http.request'],
    });

    expect(meta.methods.stop).to.containEql({
      target: StopWatch.prototype,
      name: 'StopWatch.stop',
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

  it('sort action classes', () => {
    const nodes = sortActionClasses([Logger, StopWatch, HttpServer, Tracing]);
    expect(
      nodes.map((n: any) => (typeof n === 'object' ? 'action:' + n.name : n)),
    ).to.eql([
      'log.prefix',
      'log.level',
      'action:Logger',
      'logging',
      'action:RoundtripTimer',
      'action:HttpServer',
      'action:Tracing',
    ]);
  });

  it('sort action methods', () => {
    const nodes = sortActions([
      Logger,
      StopWatch,
      HttpServer,
      MethodInvoker,
      Tracing,
    ]);

    expect(
      nodes.map((n: any) => (typeof n === 'object' ? 'action:' + n.name : n)),
    ).to.eql([
      'action:HttpServer.createRequest',
      'http.request',
      'action:StopWatch.start',
      'startTime',
      'action:Tracing.setupTracingId',
      'tracingId',
      'action:MethodInvoker.invoke',
      'invocation',
      'action:StopWatch.stop',
      'duration',
      'action:Logger.log',
      'result',
    ]);
  });

  it('bind action classes', () => {
    const classes = [Logger, StopWatch, HttpServer, MethodInvoker, Tracing];
    const nodes = sortActionClasses(classes, true);
    ctx.bind('log.level').to('INFO');
    ctx.bind('log.prefix').to('LoopBack');
    for (const c of nodes) {
      ctx
        .bind('actions.' + c.name)
        .toClass(c.target)
        .inScope(BindingScope.SINGLETON);
    }

    nodes.forEach((c: any, index: number) => {
      const v = ctx.getSync('actions.' + c.name);
      expect(v instanceof classes[index]).to.be.true();
    });
  });

  it('creates a sequence of actions', async () => {
    const actions = sortActions(
      [Logger, StopWatch, HttpServer, MethodInvoker, Tracing],
      true,
      true,
    );
    ctx.bind('log.level').to('INFO');
    ctx.bind('log.prefix').to('LoopBack');
    for (const c of actions.filter((a: any) => !a.method)) {
      ctx
        .bind('actions.' + c.name)
        .toClass(c.target)
        .inScope(BindingScope.SINGLETON);
    }

    for (const m of actions.filter((a: any) => !!a.method)) {
      const v = await ctx.get('actions.' + m.actionClass.name);
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
