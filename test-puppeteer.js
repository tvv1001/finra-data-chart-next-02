const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  
  page.on('console', msg => console.log('PAGE LOG:', msg.text()));
  
  await page.goto('http://localhost:4444/', { waitUntil: 'networkidle2' });
  
  console.log("Waiting for graph to render...");
  
  // Wait for the graph nodes to be rendered
  await page.waitForSelector('.node, [data-type="node"]', { timeout: 10000 }).catch(() => console.log("No nodes found initially"));
  
  // Try to dispatch a click event on an individual node
  await page.evaluate(() => {
    // Find a node that is an individual
    const personNodes = layoutNodes ? layoutNodes.filter(n => n.group === 'individual') : [];
    console.log(`Found ${personNodes.length} person nodes in layoutNodes`);
    
    if (personNodes.length > 0) {
      const p = personNodes[0];
      console.log(`Clicking person node: ${p.id}`);
      if (typeof window.finraGraphClick === 'function') {
        window.finraGraphClick(p);
      } else if (typeof expandNodeThroughNonGrayHops === 'function') {
        expandNodeThroughNonGrayHops(p);
      } else if (typeof selectNode === 'function') {
        selectNode(p);
      } else {
        console.log("Could not find click handler!");
      }
    }
  });
  
  await new Promise(resolve => setTimeout(resolve, 5000));
  await browser.close();
})();
