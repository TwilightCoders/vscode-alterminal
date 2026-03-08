import * as assert from 'assert';
import { TabTitleProvider } from '../../src/providers/tabTitleProvider';

suite('TabTitleProvider', () => {
  test('renders default template without process', () => {
    const provider = new TabTitleProvider();
    const template = provider.getTemplate(); // default: {base}{p? • {p}}
    const title = provider.render(template, {
      tabId: 1,
      tabName: 'Terminal',
      baseTabName: 'Terminal',
      timestamp: new Date(),
    } as any);
    assert.strictEqual(title, 'Terminal');
  });

  test('renders default template with process', () => {
    const provider = new TabTitleProvider();
    const template = provider.getTemplate(); // default: {base}{p? • {p}}
    const title = provider.render(template, {
      tabId: 2,
      tabName: 'Terminal',
      baseTabName: 'Terminal',
      processName: 'node',
      timestamp: new Date(),
    } as any);
    assert.strictEqual(title, 'Terminal • node');
  });

  test('supports conditional and nested tokens', () => {
    const provider = new TabTitleProvider();
    const template = '{n}{p? ~ {p}: (idle)}';
    const title1 = provider.render(template, {
      tabId: 3,
      tabName: 'Dev',
      baseTabName: 'Dev',
      processName: 'python',
      timestamp: new Date(),
    } as any);
    assert.strictEqual(title1, 'Dev ~ python');

    const title2 = provider.render(template, {
      tabId: 4,
      tabName: 'Dev',
      baseTabName: 'Dev',
      timestamp: new Date(),
    } as any);
    assert.strictEqual(title2, 'Dev (idle)');
  });

  suite('{title} OSC title token', () => {
    test('renders oscTitle when set', () => {
      const provider = new TabTitleProvider();
      const title = provider.render('{title}', {
        tabId: 1,
        tabName: 'Terminal',
        baseTabName: 'Terminal',
        oscTitle: 'user@host:~/project',
        timestamp: new Date(),
      } as any);
      assert.strictEqual(title, 'user@host:~/project');
    });

    test('renders empty when oscTitle is not set', () => {
      const provider = new TabTitleProvider();
      const title = provider.render('{title}', {
        tabId: 1,
        tabName: 'Terminal',
        baseTabName: 'Terminal',
        timestamp: new Date(),
      } as any);
      assert.strictEqual(title, '');
    });

    test('supports default value when oscTitle is absent', () => {
      const provider = new TabTitleProvider();
      const title = provider.render('{title:Terminal}', {
        tabId: 1,
        tabName: 'Terminal',
        baseTabName: 'Terminal',
        timestamp: new Date(),
      } as any);
      assert.strictEqual(title, 'Terminal');
    });

    test('uses oscTitle over default value when set', () => {
      const provider = new TabTitleProvider();
      const title = provider.render('{title:Terminal}', {
        tabId: 1,
        tabName: 'Terminal',
        baseTabName: 'Terminal',
        oscTitle: 'vim file.txt',
        timestamp: new Date(),
      } as any);
      assert.strictEqual(title, 'vim file.txt');
    });

    test('supports conditional rendering when oscTitle is set', () => {
      const provider = new TabTitleProvider();
      const title = provider.render('{base}{title? - {title}}', {
        tabId: 1,
        tabName: 'Terminal',
        baseTabName: 'Terminal',
        oscTitle: 'vim',
        timestamp: new Date(),
      } as any);
      assert.strictEqual(title, 'Terminal - vim');
    });

    test('hides conditional block when oscTitle is absent', () => {
      const provider = new TabTitleProvider();
      const title = provider.render('{base}{title? - {title}}', {
        tabId: 1,
        tabName: 'Terminal',
        baseTabName: 'Terminal',
        timestamp: new Date(),
      } as any);
      assert.strictEqual(title, 'Terminal');
    });

    test('supports conditional with else branch', () => {
      const provider = new TabTitleProvider();
      const template = '{title?{title}:no title}';

      const withTitle = provider.render(template, {
        tabId: 1,
        tabName: 'Terminal',
        baseTabName: 'Terminal',
        oscTitle: 'htop',
        timestamp: new Date(),
      } as any);
      assert.strictEqual(withTitle, 'htop');

      const withoutTitle = provider.render(template, {
        tabId: 2,
        tabName: 'Terminal',
        baseTabName: 'Terminal',
        timestamp: new Date(),
      } as any);
      assert.strictEqual(withoutTitle, 'no title');
    });

    test('combines with process token in complex template', () => {
      const provider = new TabTitleProvider();
      const template = '{base}{p? • {p}}{title? [{title}]}';

      const both = provider.render(template, {
        tabId: 1,
        tabName: 'Terminal',
        baseTabName: 'Terminal',
        processName: 'ssh',
        oscTitle: 'user@host:~',
        timestamp: new Date(),
      } as any);
      assert.strictEqual(both, 'Terminal • ssh [user@host:~]');

      const processOnly = provider.render(template, {
        tabId: 2,
        tabName: 'Terminal',
        baseTabName: 'Terminal',
        processName: 'node',
        timestamp: new Date(),
      } as any);
      assert.strictEqual(processOnly, 'Terminal • node');

      const neither = provider.render(template, {
        tabId: 3,
        tabName: 'Terminal',
        baseTabName: 'Terminal',
        timestamp: new Date(),
      } as any);
      assert.strictEqual(neither, 'Terminal');
    });

    test('default template is unaffected by oscTitle being set', () => {
      const provider = new TabTitleProvider();
      const template = provider.getTemplate(); // default: {base}{p? • {p}}
      const title = provider.render(template, {
        tabId: 1,
        tabName: 'Terminal',
        baseTabName: 'Terminal',
        oscTitle: 'should not appear',
        processName: 'node',
        timestamp: new Date(),
      } as any);
      assert.strictEqual(title, 'Terminal • node');
    });
  });
});
