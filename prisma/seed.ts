import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // ============================================================
  // MARKETPLACE
  // ============================================================

  console.log('Seeding marketplace catalog...');

  const categories = [
    {
      id: 'cat-groceries',
      name: 'Groceries',
      icon: 'shopping-basket',
    },
    {
      id: 'cat-snacks',
      name: 'Snacks & Drinks',
      icon: 'cup-soda',
    },
    {
      id: 'cat-stationery',
      name: 'Stationery',
      icon: 'pen-tool',
    },
    {
      id: 'cat-toiletries',
      name: 'Toiletries',
      icon: 'droplets',
    },
    {
      id: 'cat-tech',
      name: 'Tech & Accessories',
      icon: 'smartphone',
    },
    {
      id: 'cat-fashion',
      name: 'Campus Fashion',
      icon: 'shirt',
    },
  ];

  const vendors = [
    {
      id: 'mv1',
      name: 'Unity Hall Mart',
      location: 'Unity Hall, KNUST',
    },
    {
      id: 'mv2',
      name: 'Commercial Area',
      location: 'Commercial Area, KNUST',
    },
    {
      id: 'mv3',
      name: 'KNUST Tech Hub',
      location: 'KNUST',
    },
    {
      id: 'mv4',
      name: 'Republic Hall Merch',
      location: 'Republic Hall, KNUST',
    },
  ];

  const products = [
    {
      id: 'p1',
      name: 'Indomie Multipack (5)',
      description:
        'Classic chicken flavour — hostel midnight essential.',
      price: 18,
      stock: 100,
      imageUrl:
        'https://images.pexels.com/photos/4518843/pexels-photo-4518843.jpeg',
      categoryId: 'cat-groceries',
      vendorId: 'mv1',
      unit: 'pack',
    },
    {
      id: 'p2',
      name: 'Voltic Water 1.5L',
      price: 5,
      stock: 100,
      categoryId: 'cat-snacks',
      vendorId: 'mv1',
    },
    {
      id: 'p3',
      name: 'Exercise Books (4pk)',
      price: 22,
      stock: 100,
      categoryId: 'cat-stationery',
      vendorId: 'mv2',
    },
    {
      id: 'p4',
      name: 'USB-C Cable 1m',
      price: 35,
      stock: 50,
      categoryId: 'cat-tech',
      vendorId: 'mv3',
    },
    {
      id: 'p5',
      name: 'Body Wash 400ml',
      price: 28,
      stock: 50,
      categoryId: 'cat-toiletries',
      vendorId: 'mv1',
    },
    {
      id: 'p6',
      name: 'Campus Hoodie',
      price: 120,
      stock: 25,
      categoryId: 'cat-fashion',
      vendorId: 'mv4',
    },
    {
      id: 'p7',
      name: 'Gari & Groundnut Set',
      price: 15,
      stock: 75,
      categoryId: 'cat-groceries',
      vendorId: 'mv1',
    },
    {
      id: 'p8',
      name: 'Energy Drink 500ml',
      price: 12,
      stock: 75,
      categoryId: 'cat-snacks',
      vendorId: 'mv2',
    },
    {
      id: 'p9',
      name: 'Highlighter Set',
      price: 16,
      stock: 50,
      categoryId: 'cat-stationery',
      vendorId: 'mv2',
    },
    {
      id: 'p10',
      name: 'Wireless Earbuds',
      price: 95,
      stock: 30,
      categoryId: 'cat-tech',
      vendorId: 'mv3',
    },
    {
      id: 'p11',
      name: 'Laundry Detergent 1kg',
      price: 32,
      stock: 40,
      categoryId: 'cat-toiletries',
      vendorId: 'mv1',
    },
    {
      id: 'p12',
      name: 'KNUST Cap',
      price: 45,
      stock: 0,
      categoryId: 'cat-fashion',
      vendorId: 'mv4',
    },
  ];

  for (const category of categories) {
    await prisma.category.upsert({
      where: { id: category.id },
      update: category,
      create: category,
    });
  }

  for (const vendor of vendors) {
    await prisma.marketplaceVendor.upsert({
      where: { id: vendor.id },
      update: vendor,
      create: vendor,
    });
  }

  for (const product of products) {
    await prisma.product.upsert({
      where: { id: product.id },
      update: product,
      create: product,
    });
  }

  console.log(`Seeded ${categories.length} marketplace categories.`);
  console.log(`Seeded ${vendors.length} marketplace vendors.`);
  console.log(`Seeded ${products.length} marketplace products.`);
  console.log('Marketplace seed completed successfully.');

  // ============================================================
  // FOOD
  // ============================================================

  console.log('Seeding food catalog...');

  const foodCategories = [
    {
      id: 'fc-local',
      name: 'Local Dishes',
      icon: 'utensils',
      service: 'food',
    },
    {
      id: 'fc-fast',
      name: 'Fast Bites',
      icon: 'burger',
      service: 'food',
    },
    {
      id: 'fc-breakfast',
      name: 'Breakfast',
      icon: 'coffee',
      service: 'food',
    },
    {
      id: 'fc-drinks',
      name: 'Drinks',
      icon: 'cup-soda',
      service: 'food',
    },
  ];

  const foodVendors = [
    {
      id: 'v1',
      name: 'Unity Hall Canteen',
      description:
        'Waakye, jollof, and banku — student favourites.',
      imageUrl:
        'https://images.pexels.com/photos/2290737/pexels-photo-2290737.jpeg',
      categoryIds: ['fc-local', 'fc-breakfast'],
      rating: 4.6,
      reviewCount: 412,
      deliveryTimeMin: 25,
      deliveryFee: 5,
      minOrder: 20,
      isOpen: true,
      location: 'Unity Hall',
      isActive: true,
    },
    {
      id: 'v2',
      name: 'Ayeduase Chop Bar',
      description:
        'Fufu, light soup, and grilled tilapia near the gate.',
      imageUrl:
        'https://images.pexels.com/photos/36782591/pexels-photo-36782591.jpeg',
      categoryIds: ['fc-local'],
      rating: 4.8,
      reviewCount: 268,
      deliveryTimeMin: 35,
      deliveryFee: 8,
      minOrder: 30,
      isOpen: true,
      location: 'Ayeduase',
      isActive: true,
    },
    {
      id: 'v3',
      name: 'Brunei Fast Food',
      description:
        'Burgers, fries, and sharwarma for late nights.',
      imageUrl:
        'https://images.pexels.com/photos/14415371/pexels-photo-14415371.jpeg',
      categoryIds: ['fc-fast', 'fc-drinks'],
      rating: 4.4,
      reviewCount: 190,
      deliveryTimeMin: 20,
      deliveryFee: 6,
      minOrder: 25,
      isOpen: true,
      location: 'Brunei Complex',
      isActive: true,
    },
    {
      id: 'v4',
      name: 'Katanga Tea Spot',
      description:
        'Porridge, tea, and soft breads for early lectures.',
      imageUrl:
        'https://images.pexels.com/photos/612790/pexels-photo-612790.jpeg',
      categoryIds: ['fc-breakfast', 'fc-drinks'],
      rating: 4.5,
      reviewCount: 156,
      deliveryTimeMin: 18,
      deliveryFee: 4,
      minOrder: 15,
      isOpen: false,
      location: 'Katanga Hall',
      isActive: true,
    },
  ];

  const foodItems = [
    {
      id: 'f1',
      vendorId: 'v1',
      name: 'Waakye Special',
      description:
        'With wele, egg, spaghetti, and shito.',
      price: 28,
      imageUrl:
        'https://images.unsplash.com/photo-1610592309005-0f92c8e39cec?w=500&auto=format&fit=crop&q=60&ixlib=rb-4.1.0&ixid=M3wxMjA3fDB8MHxzZWFyY2h8N3x8Z2hhbmFpYW4lMjBmb29kfGVufDB8fDB8fHww',
      category: 'Local',
      isAvailable: true,
      rating: 4.8,
    },
    {
      id: 'f2',
      vendorId: 'v1',
      name: 'Jollof + Chicken',
      description:
        'Party jollof with grilled chicken.',
      price: 35,
      imageUrl:
        'https://images.pexels.com/photos/13915043/pexels-photo-13915043.jpeg',
      category: 'Local',
      isAvailable: true,
      rating: 4.7,
    },
    {
      id: 'f3',
      vendorId: 'v1',
      name: 'Hausa Koko + Koose',
      description:
        'Morning staple — spicy koose on the side.',
      price: 12,
      imageUrl:
        'https://images.pexels.com/photos/37624176/pexels-photo-37624176.jpeg',
      category: 'Breakfast',
      isAvailable: true,
      rating: 4.6,
    },
    {
      id: 'f4',
      vendorId: 'v2',
      name: 'Fufu & Light Soup',
      description:
        'Goat meat light soup, smooth fufu.',
      price: 40,
      imageUrl:
        'https://images.pexels.com/photos/34533967/pexels-photo-34533967.jpeg',
      category: 'Local',
      isAvailable: true,
      rating: 4.9,
    },
    {
      id: 'f5',
      vendorId: 'v2',
      name: 'Banku & Tilapia',
      description:
        'Grilled tilapia with pepper and banku.',
      price: 55,
      imageUrl:
        'https://images.pexels.com/photos/633627/pexels-photo-633627.jpeg',
      category: 'Local',
      isAvailable: true,
      rating: 4.8,
    },
    {
      id: 'f6',
      vendorId: 'v3',
      name: 'Chicken Sharwarma',
      description:
        'Loaded wrap with fries.',
      price: 32,
      imageUrl:
        'https://images.pexels.com/photos/29306505/pexels-photo-29306505.jpeg',
      category: 'Fast',
      isAvailable: true,
      rating: 4.5,
    },
    {
      id: 'f7',
      vendorId: 'v3',
      name: 'Beef Burger Meal',
      description:
        'Burger, fries, and soft drink.',
      price: 45,
      imageUrl:
        'https://images.pexels.com/photos/15365133/pexels-photo-15365133.jpeg',
      category: 'Fast',
      isAvailable: true,
      rating: 4.3,
    },
    {
      id: 'f8',
      vendorId: 'v4',
      name: 'Tea & Bread Combo',
      description:
        'Milk tea with soft buttered bread.',
      price: 10,
      imageUrl:
        'https://images.pexels.com/photos/15776588/pexels-photo-15776588.jpeg',
      category: 'Breakfast',
      isAvailable: true,
      rating: 4.4,
    },
  ];

  for (const category of foodCategories) {
    await prisma.foodCategory.upsert({
      where: { id: category.id },
      update: category,
      create: category,
    });
  }

  for (const vendor of foodVendors) {
    await prisma.foodVendor.upsert({
      where: { id: vendor.id },
      update: vendor,
      create: vendor,
    });
  }

  for (const item of foodItems) {
    await prisma.menuItem.upsert({
      where: { id: item.id },
      update: item,
      create: item,
    });
  }

  console.log(`Seeded ${foodCategories.length} food categories.`);
  console.log(`Seeded ${foodVendors.length} food vendors.`);
  console.log(`Seeded ${foodItems.length} food menu items.`);
  console.log('Food seed completed successfully.');

  // ============================================================
  // SUMMARY
  // ============================================================

  console.log('');
  console.log('========================================');
  console.log('Database seed completed successfully.');
  console.log('========================================');
}

main()
  .catch((error) => {
    console.error('Database seed failed:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });