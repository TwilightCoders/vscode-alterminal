import * as assert from 'assert';
import { TabTitleProvider } from '../../src/providers/tabTitleProvider';

describe('TabTitleProvider', () => {
  it('renders default template without process', () => {
    const provider = new TabTitleProvider();
    const template = provider.getTemplate(); // default: {n}{p? • {p}}
    const title = provider.render(template, {
      tabId: 1,
      tabName: 'Terminal',
      baseTabName: 'Terminal',
      timestamp: new Date(),
    } as any);
    assert.strictEqual(title, 'Terminal');
  });

  it('renders default template with process', () => {
    const provider = new TabTitleProvider();
    const template = provider.getTemplate(); // default: {n}{p? • {p}}
    const title = provider.render(template, {
      tabId: 2,
      tabName: 'Terminal',
      baseTabName: 'Terminal',
      processName: 'node',
      timestamp: new Date(),
    } as any);
    assert.strictEqual(title, 'Terminal • node');
  });

  it('supports conditional and nested tokens', () => {
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
});
