import "reflect-metadata";

export type Constructor<T> = Function & { prototype: T }; // this describes an abstract class constructor
export type IConcreteConstructor<T> = new(...args: any[]) => T;
export type FactoryFunction<T> = () => T | Promise<T>;

// tslint:disable
export function SupportsInjection(target: any, propertyKey: string | symbol, descriptor: PropertyDescriptor): any;
export function SupportsInjection<T extends { new(...args: any[]): {} }>(constructor: T): any;
export function SupportsInjection() {
    // The decorator has no content but still does its magic. We provide
    // overloads to support both constructor and method decoration.
}
// tslint:enable

interface ITypedRegistration<T> {
    resolve(argumentBuilder: (type: IConcreteConstructor<T>) => Promise<any[]>): Promise<T>;
}

type FunctionPropertyNames<T> = { [K in keyof T]: T[K] extends Function ? K : never }[keyof T];

class TransientRegistration<T> implements ITypedRegistration<T> {
    constructor(private _type: IConcreteConstructor<T>) {
    }

    public async resolve(argumentBuilder: (type: IConcreteConstructor<T>) => Promise<any[]>): Promise<T> {
        const args = await argumentBuilder(this._type);
        return new this._type(...args);
    }
}

class SingletonRegistration<T> implements ITypedRegistration<T> {
    private _instance: Promise<T> | undefined;

    constructor(private _type: IConcreteConstructor<T>) {
    }

    public async resolve(argumentBuilder: (type: IConcreteConstructor<T>) => Promise<any[]>): Promise<T> {
        if (this._instance != undefined) {
            return this._instance;
        }

        this._instance = new Promise(async resolve => {
            const args = await argumentBuilder(this._type);
            resolve(new this._type(...args));
        });

        return this._instance;
    }
}

class InstanceRegistration<T> implements ITypedRegistration<T> {
    constructor(private _instance: T) {
    }

    public async resolve(argumentBuilder: (type: IConcreteConstructor<T>) => Promise<any[]>): Promise<T> {
        return this._instance;
    }
}

class FactoryRegistration<T> implements ITypedRegistration<T> {
    constructor(private _factory: FactoryFunction<T>) {
    }

    public async resolve(argumentBuilder: (type: IConcreteConstructor<T>) => Promise<any[]>): Promise<T> {
        return this._factory();
    }
}

class SingletonFactoryRegistration<T> implements ITypedRegistration<T> {
    private _instance: Promise<T> | undefined;

    constructor(private _factory: FactoryFunction<T>) {
    }

    public async resolve(argumentBuilder: (type: IConcreteConstructor<T>) => Promise<any[]>): Promise<T> {
        if (this._instance != undefined) {
            return this._instance;
        }

        this._instance = new Promise(async resolve => {
            resolve(this._factory());
        });

        return this._instance;
    }
}

export class Container {
    private _parameterTypes: Map<Function, any[]> = new Map<Function, any[]>();
    private _providers: Map<Function, ITypedRegistration<any>> = new Map<Function, ITypedRegistration<any>>();

    public registerTransient<T>(self: IConcreteConstructor<T>): void;
    public registerTransient<From, To extends From>(when: Constructor<From>, then: IConcreteConstructor<To>): void;
    public registerTransient<From, To extends From>(when: Constructor<From> | IConcreteConstructor<From>, then?: IConcreteConstructor<To>): void {
        if (when == undefined) {
            throw new Error(`Cannot register null or undefined as transient. Did you intend to call unregister?`);
        }

        if (then == undefined) {
            // the reason we can safely do this type case here is that there are only two overloads;
            // the one overload that has no second argument (no "to") ensures that the first one is IConcreteConstructor<T>
            // also: From extends From === true
            then = when as IConcreteConstructor<To>;
        }

        this.register(when, then, new TransientRegistration<To>(then));
    }

    public registerSingleton<T>(self: IConcreteConstructor<T>): void;
    public registerSingleton<From, To extends From>(when: Constructor<From>, then: IConcreteConstructor<To>): void;
    public registerSingleton<From, To extends From>(when: Constructor<From> | IConcreteConstructor<From>, then?: IConcreteConstructor<To>): void {
        if (when == undefined) {
            throw new Error(`Cannot register null or undefined as singleton. Did you intend to call unregister?`);
        }

        if (then == undefined) {
            // the reason we can safely do this type case here is that there are only two overloads;
            // the one overload that has no second argument (no "to") ensures that the first one is IConcreteConstructor<T>
            // also: From extends From === true
            then = when as IConcreteConstructor<To>;
        }

        this.register(when, then, new SingletonRegistration<To>(then));
    }

    public registerInstance<T>(when: Constructor<T>, then: T): void {
        if (then == undefined) {
            throw new Error(`Cannot register null or undefined as instance. Did you intend to call unregister?`);
        }

        // this basically checks for "function" !== "object" e.g. if someone uses trivial types for registration
        // and passes in a factory function as "then" instead of a real instance (see explanation in unit tests).
        if (typeof(then) !== typeof(when.prototype)) {
            throw new Error(`You need to register an instance with the same type as the prototype of the source.`);
        }

        this._providers.set(when, new InstanceRegistration<T>(then));
    }

    public registerFactory<T>(when: Constructor<T>, then: FactoryFunction<T>) {
        if (then == undefined) {
            throw new Error(`Cannot register null or undefined as factory. Did you intend to call unregister?`);
        }

        this._providers.set(when, new FactoryRegistration<T>(then));
    }

    public registerSingletonFactory<T>(when: Constructor<T>, then: FactoryFunction<T>) {
        if (then == undefined) {
            throw new Error(`Cannot register null or undefined as singleton factory. Did you intend to call unregister?`);
        }

        this._providers.set(when, new SingletonFactoryRegistration<T>(then));
    }

    public unregister<T>(type: Constructor<T>): void {
        if (type == undefined) {
            throw new Error(`Cannot unregister null or undefined type`);
        }

        const registration = this._providers.get(type);
        if (registration == undefined) {
            return;
        }

        this._providers.delete(type);
    }

    public async resolve<T>(type: Constructor<T>): Promise<T> {
        if (type == undefined) {
            throw new Error(`Cannot resolve null or undefined type`);
        }

        const registration = this._providers.get(type) as ITypedRegistration<T>;

        if (registration == undefined) {
            throw new Error(`No registration found for type '${type.name}'`);
        }

        return await registration.resolve(async toResolve => await this.createArgs(toResolve));
    }

    public async invoke<T extends any, U extends FunctionPropertyNames<T>>(instance: T, methodName: U): Promise<ReturnType<T[U]>> {
        if (instance == undefined) {
            throw new Error(`Cannot invoke on a null or undefined type`);
        }

        if (!(methodName in instance)) {
            throw new Error(`${methodName} does not exist on ${instance.toString()}`);
        }

        if (typeof(instance[methodName]) !== "function") {
            throw new Error(`${methodName} of ${instance.toString()} is not callable`);
        }

        const argTypes = Reflect.getMetadata("design:paramtypes", instance, <string> methodName);
        const args = await Promise.all(argTypes.map(async (x: any) => await this.resolve(x)));

        return (<Function> instance[methodName]).apply(instance, args);
    }

    private register<From, To extends From>(when: Constructor<From>, then: IConcreteConstructor<To>, registration: ITypedRegistration<To>): void {
        const paramTypes: any[] = Reflect.getMetadata("design:paramtypes", then);
        this._parameterTypes.set(then, paramTypes);
        this._providers.set(when, registration);
    }

    private async createArgs<T>(type: IConcreteConstructor<T>): Promise<any[]> {
        const paramTypes = this._parameterTypes.get(type);
        if (paramTypes == undefined) {
            return [];
        }

        return await Promise.all(paramTypes.map(async x => await this.resolve(x)));
    }
}
